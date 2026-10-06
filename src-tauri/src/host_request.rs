use std::collections::BTreeMap;
use std::time::Duration;

use buzzodz_plugins::HostGrants;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::{with_manager, PluginManager};

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8192;
const MAX_RESPONSE_HEADER_BYTES: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Serialize)]
pub(crate) struct HostResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[tauri::command]
pub(crate) async fn plugin_host_request(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    request: HostRequest,
) -> Result<HostResponse, String> {
    let (url, method, headers) = validate_request(&request)?;
    let operation = async {
        let grants = with_manager(manager, move |manager| manager.host_grants(&id, &revision))
            .await
            .map_err(|_| "Host request is unavailable")?;
        if !allows_origin(&grants, &url) {
            return Err("Host request origin is not declared".into());
        }
        send_request(url, method, headers, request.body).await
    };
    tokio::time::timeout(DEADLINE, operation)
        .await
        .map_err(|_| "Host request timed out")?
}

fn allows_origin(grants: &HostGrants, url: &reqwest::Url) -> bool {
    grants
        .network_origins
        .contains(&url.origin().ascii_serialization())
}

fn validate_request(
    request: &HostRequest,
) -> Result<(reqwest::Url, reqwest::Method, HeaderMap), String> {
    if request.url.len() > 2048 {
        return Err("Invalid host request URL".into());
    }
    let url = reqwest::Url::parse(&request.url).map_err(|_| "Invalid host request URL")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Host requests require HTTPS without URL credentials".into());
    }
    let method = match request.method.as_str() {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Invalid host request method".into()),
    };
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BYTES)
    {
        return Err("Host request body is too large".into());
    }
    if request.headers.len() > 32
        || request
            .headers
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > MAX_HEADER_BYTES
    {
        return Err("Host request headers are too large".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid host request header")?;
        if matches!(
            name.as_str(),
            "host"
                | "cookie"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "proxy-connection"
                | "connection"
                | "keep-alive"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
                | "content-length"
        ) {
            return Err("Host request header is not allowed".into());
        }
        let value = HeaderValue::from_str(value).map_err(|_| "Invalid host request header")?;
        headers.insert(name, value);
    }
    Ok((url, method, headers))
}

async fn send_request(
    url: reqwest::Url,
    method: reqwest::Method,
    headers: HeaderMap,
    body: Option<String>,
) -> Result<HostResponse, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DEADLINE)
        .build()
        .map_err(|_| "Host request client is unavailable")?;
    let mut request = client.request(method, url).headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    let mut response = request.send().await.map_err(|_| "Host request failed")?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    let mut header_bytes = 0;
    let mut header_count = 0;
    for (name, value) in response.headers() {
        if name.as_str() == "set-cookie" {
            continue;
        }
        let Ok(value) = value.to_str() else {
            continue;
        };
        header_count += 1;
        header_bytes += name.as_str().len() + value.len();
        if header_count > 64 || header_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err("Host response headers are too large".into());
        }
        headers.insert(name.to_string(), value.to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Host response failed")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Host response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "Host response is not UTF-8")?;
    Ok(HostResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn local_response(response: Vec<u8>) -> (reqwest::Url, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(request[..count].starts_with(b"POST /graphql HTTP/1.1"));
            let _ = socket.write_all(&response);
        });
        (
            reqwest::Url::parse(&format!("http://{address}/graphql")).unwrap(),
            server,
        )
    }

    fn request(url: &str) -> HostRequest {
        HostRequest {
            url: url.into(),
            method: "POST".into(),
            headers: BTreeMap::new(),
            body: Some("{}".into()),
        }
    }

    #[test]
    fn validates_https_url_and_bounds() {
        assert!(validate_request(&request("https://api.example.test/graphql")).is_ok());
        assert!(validate_request(&request("http://api.example.test/graphql")).is_err());
        assert!(validate_request(&request("https://user:pass@api.example.test/")).is_err());
        let mut large = request("https://api.example.test/");
        large.body = Some("x".repeat(MAX_REQUEST_BYTES + 1));
        assert!(validate_request(&large).is_err());
    }

    #[test]
    fn rejects_cookie_and_routing_headers() {
        for name in [
            "Host",
            "Cookie",
            "Proxy-Authorization",
            "Proxy-Connection",
            "Connection",
            "Transfer-Encoding",
        ] {
            let mut input = request("https://api.example.test/");
            input.headers.insert(name.into(), "private".into());
            assert!(validate_request(&input).is_err(), "{name}");
        }
    }

    #[test]
    fn matches_only_the_declared_origin() {
        let grants = HostGrants {
            commands: vec![],
            network_origins: vec!["https://api.example.test".into()],
            ..HostGrants::default()
        };
        for url in [
            "https://api.example.test/",
            "https://api.example.test/graphql",
        ] {
            assert!(allows_origin(&grants, &reqwest::Url::parse(url).unwrap()));
        }
        for url in [
            "https://sub.api.example.test/",
            "https://api.example.test:8443/",
        ] {
            assert!(!allows_origin(&grants, &reqwest::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn bundled_builderlab_uses_native_grants_for_exact_request_origins() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let grants = manager.host_grants("block.builderlab", "bundled").unwrap();
        let origin = grants
            .network_origins
            .first()
            .map(String::as_str)
            .unwrap_or("https://app.builderlab.xyz");
        let (url, _, _) = validate_request(&request(&format!(
            "{origin}/api/goose/v1/auth/login/exchange"
        )))
        .unwrap();
        assert_eq!(
            allows_origin(&grants, &url),
            !grants.network_origins.is_empty()
        );
        let mut other = url;
        other
            .set_port(Some(if other.port() == Some(8443) {
                9443
            } else {
                8443
            }))
            .unwrap();
        let (url, _, _) = validate_request(&request(other.as_str())).unwrap();
        assert!(!allows_origin(&grants, &url));
    }

    #[test]
    fn bundled_hosted_communities_reach_only_the_builderlab_origin() {
        let temp = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let grants = manager
            .host_grants("block.hosted-communities", "bundled")
            .unwrap();
        assert_eq!(grants.network_origins, ["https://app.builderlab.xyz"]);
        assert!(grants.commands.is_empty());
        for (url, allowed) in [
            ("https://app.builderlab.xyz/api/goose/v1/auth/me", true),
            ("https://builderlab.xyz/api/goose/v1/auth/me", false),
            (
                "https://app.builderlab.xyz:8443/api/goose/v1/auth/me",
                false,
            ),
        ] {
            let (url, _, _) = validate_request(&request(url)).unwrap();
            assert_eq!(allows_origin(&grants, &url), allowed, "{url}");
        }
    }

    #[tokio::test]
    async fn request_transport_does_not_follow_redirects_or_return_cookies() {
        // The handler rejects HTTP; loopback HTTP exercises the transport without external data.
        let (url, server) = local_response(
            b"HTTP/1.1 302 Found\r\nLocation: https://outside.example/\r\nSet-Cookie: secret=value\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
        );
        let response = send_request(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            Some("{}".into()),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(response.body, "{}");
        assert_eq!(
            response.headers.get("location").unwrap(),
            "https://outside.example/"
        );
        assert!(!response.headers.contains_key("set-cookie"));
    }

    #[tokio::test]
    async fn request_transport_rejects_oversized_responses() {
        let body = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body);
        let (url, server) = local_response(response);
        let result = send_request(url, reqwest::Method::POST, HeaderMap::new(), None).await;
        server.join().unwrap();
        assert_eq!(result.err().as_deref(), Some("Host response is too large"));
    }

    #[tokio::test]
    async fn request_transport_bounds_returned_headers() {
        let mut response = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n".to_vec();
        for index in 0..65 {
            response.extend(format!("x-example-{index}: value\r\n").as_bytes());
        }
        response.extend(b"\r\n");
        let (url, server) = local_response(response);
        let result = send_request(url, reqwest::Method::POST, HeaderMap::new(), None).await;
        server.join().unwrap();
        assert_eq!(
            result.err().as_deref(),
            Some("Host response headers are too large")
        );
    }
}
