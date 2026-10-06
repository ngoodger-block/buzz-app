import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/** The keyboard highlight of a search picker. Focus stays in the search
 * field: Up and Down move the highlight, and Enter chooses the highlighted
 * row. Typed text highlights the first row, so Enter chooses it without an
 * arrow key. The highlight follows a row's key, not its position, as late
 * results arrive: a row inserted above cannot redirect Enter. When the
 * highlighted row leaves, the highlight returns to the first row rather than
 * reviving the old one. The hook draws nothing; rows keep their own markup. */
export function useSearchHighlight({
  query,
  keys,
  onChoose,
  open = true,
  onOpen,
  highlightEmpty = false,
  wrap = false,
}: {
  query: string;
  /** Row keys, in display order. */
  keys: readonly string[];
  onChoose: (key: string) => void;
  /** Whether the rows are showing, for a picker in a popup. Reopening
   * scrolls the highlighted row back into view. */
  open?: boolean;
  /** Called when Up or Down opens a closed popup. The key highlights the
   * first or last row. */
  onOpen?: () => void;
  /** Highlight the first row before anything is typed, for a picker whose
   * unfiltered list is already the list to choose from. */
  highlightEmpty?: boolean;
  /** Up from the first row goes to the last, and Down from the last row
   * goes to the first. */
  wrap?: boolean;
}) {
  const id = useId();
  const [selection, setSelection] = useState({
    query,
    key: "",
    pointer: false,
    /** Counts keyboard moves, so each one reveals its row, even the same row
     * after the list was scrolled away from it. */
    moves: 0,
  });
  const valid = selection.query === query && keys.includes(selection.key);
  const fallback = highlightEmpty || query.trim() ? (keys[0] ?? "") : "";
  if (!valid && (selection.query !== query || selection.key !== fallback))
    setSelection({ query, key: fallback, pointer: false, moves: 0 });
  const active = valid ? selection.key : fallback;
  const rowId = (key: string) => `${id}-${key}`;
  const select = (key: string) =>
    setSelection((previous) => ({
      query,
      key,
      pointer: false,
      moves: previous.moves + 1,
    }));
  // WebKit replays a pointer event when rows move under a resting cursor.
  // Only a real move may highlight a row, or new results would steal Enter.
  // Compare viewport coordinates: Linux WebKit reports screen coordinates
  // that do not change as the pointer moves.
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const pointerMoved = (event: PointerEvent) => {
    const last = pointer.current;
    pointer.current = { x: event.clientX, y: event.clientY };
    return !!last && (last.x !== event.clientX || last.y !== event.clientY);
  };
  // The pointer is already on a row it highlights; keep the list still.
  const scroll = open && !(valid && selection.pointer) ? active : "";
  const moves = selection.moves;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each keyboard move reveals its row again.
  useEffect(() => {
    if (!scroll) return;
    const reveal = () =>
      document
        .getElementById(`${id}-${scroll}`)
        ?.scrollIntoView({ block: "nearest" });
    if (document.getElementById(`${id}-${scroll}`)) return void reveal();
    // A popup that just opened can mount its rows after this render.
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [scroll, moves, id]);
  return {
    /** The highlighted row's key, or "" for none. */
    active,
    select,
    listId: id,
    rowId,
    /** Spread on the search field. */
    fieldProps: {
      "aria-activedescendant": open && active ? rowId(active) : undefined,
    },
    /** Spread on the element that contains the rows. */
    listProps: {
      onPointerMove(event: PointerEvent) {
        pointer.current = { x: event.clientX, y: event.clientY };
      },
    },
    /** Spread on each row. */
    rowProps: (key: string) => ({
      id: rowId(key),
      // Tab can focus a row. Enter then chooses that row, so highlight it
      // and announce it. The row is already in view, so do not scroll.
      onFocus() {
        if (active !== key)
          setSelection((previous) => ({
            ...previous,
            query,
            key,
            pointer: true,
          }));
      },
      onPointerMove(event: PointerEvent) {
        if (
          event.pointerType !== "touch" &&
          pointerMoved(event) &&
          active !== key
        )
          setSelection((previous) => ({
            ...previous,
            query,
            key,
            pointer: true,
          }));
      },
    }),
    /** Call from the search field's keydown handler. Returns whether the key
     * was handled. Keys during IME composition or with Cmd, Ctrl or Alt are
     * never handled. While closed, only Up and Down are, through `onOpen`. */
    keyDown(event: KeyboardEvent) {
      if (
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return false;
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      const down = event.key === "ArrowDown";
      if (!open) {
        if (!arrow || !keys.length || !onOpen) return false;
        event.preventDefault();
        onOpen();
        select((down ? keys[0] : keys.at(-1)) ?? "");
        return true;
      }
      const index = keys.indexOf(active);
      if (event.key === "Enter" && index >= 0) {
        event.preventDefault();
        onChoose(active);
        return true;
      }
      if (arrow && keys.length) {
        event.preventDefault();
        const step = index + (down ? 1 : -1);
        const next =
          index < 0
            ? down
              ? 0
              : keys.length - 1
            : wrap
              ? (step + keys.length) % keys.length
              : Math.max(0, Math.min(keys.length - 1, step));
        select(keys[next] ?? "");
        return true;
      }
      return false;
    },
  };
}
