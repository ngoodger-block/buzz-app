import { useLayoutEffect, useRef } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { RelaySession } from "../relay/session";
import {
  cancelBackgroundUpload,
  dismissBackgroundUploadNotice,
  useBackgroundUploads,
} from "./background-upload";
import styles from "./Messages.module.css";

/** Desktop's composer upload pill and failure toasts, for this session's sends. */
export function BackgroundUploadStatus({
  session,
  focusTarget,
}: {
  session: RelaySession;
  focusTarget: React.RefObject<HTMLElement | null>;
}) {
  const uploads = useBackgroundUploads(session);
  const focusedCancel = useRef(false);
  useLayoutEffect(() => {
    if (uploads.uploading || !focusedCancel.current) return;
    focusedCancel.current = false;
    const target = focusTarget.current;
    if (
      document.activeElement === document.body &&
      target?.isConnected &&
      !target.closest("[inert]") &&
      !target.hasAttribute("disabled")
    )
      target.focus();
  }, [uploads.uploading, focusTarget]);
  const label =
    uploads.phase === "Uploading"
      ? `${uploads.phase} ${uploads.percentage}%`
      : uploads.phase;
  return (
    <>
      {uploads.uploading && (
        <div className={styles.backgroundUpload}>
          <span role="status">{label}</span>
          <Button
            onFocus={() => {
              focusedCancel.current = true;
            }}
            onBlur={(event) => {
              // A real move away relinquishes ownership; removal of the
              // focused control does not dispatch blur.
              if (
                event.relatedTarget ||
                document.activeElement === document.body
              )
                focusedCancel.current = false;
            }}
            size="sm"
            variant="ghost"
            onClick={() => cancelBackgroundUpload(session)}
          >
            Cancel
          </Button>
        </div>
      )}
      {uploads.notices.map((notice) => (
        <ToastNotice
          key={notice.id}
          title={notice.message}
          {...(!notice.retry && {
            onDismiss: () => dismissBackgroundUploadNotice(session, notice.id),
          })}
        >
          {notice.retry && (
            <Button type="button" onClick={notice.retry}>
              Retry failed send recovery
            </Button>
          )}
        </ToastNotice>
      ))}
    </>
  );
}
