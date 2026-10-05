import { useSyncExternalStore } from "react";
import {
  dateEnvironmentSnapshot,
  subscribeDateEnvironment,
} from "./date-environment";

/** Refresh date labels when the shared day, locale or timezone snapshot changes. */
export function useLocalDay() {
  return useSyncExternalStore(
    subscribeDateEnvironment,
    dateEnvironmentSnapshot,
    dateEnvironmentSnapshot,
  );
}
