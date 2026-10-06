# Browser development host

This directory contains the Node host used by live browser development and
broker-backed tests, plus development tooling. It is checked-in source, not a
cache or another relay server. Packaged desktop uses the native Rust host.

See [shared logic and host boundaries](../docs/contributing.md#shared-logic-and-host-boundaries)
for the runtime/identity matrix, ownership rules and cross-host test expectations.
Keep platform-neutral feature policy under its existing `src/features/*` owner;
retain host custody and boundary enforcement here. Existing tests are discovered
by Vitest. [Broker setup](../README.md#relay-channels) requires an explicit public
identity pin; never put a private key in environment configuration.
