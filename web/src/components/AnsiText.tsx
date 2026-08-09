import { useMemo } from "react";
import Anser from "anser";

/** Drop ANSI escape codes, leaving plain text — for the "copy log" path so a paste is clean. */
export const stripAnsi = (text: string): string =>
  Anser.ansiToJson(text, { remove_empty: true }).map((seg) => seg.content).join("");

/** Render a log line's text with its ANSI colour codes turned into styled spans (anser → React
 *  spans; no dangerouslySetInnerHTML). Remote tools — the installer's [INFO]/[STEP]/[WARN]/[OK]/
 *  [ERROR], plus helm/kubectl/git — colour their output with ANSI escape sequences; without this
 *  the raw `\x1b[0;34m` codes showed as garbage. The `ansi-*-fg` class names anser emits are themed
 *  for the dark log viewer in screens.css; a segment with no colour inherits the line's stream
 *  colour (stdout/stderr/meta). */
export function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => Anser.ansiToJson(text, { use_classes: true, remove_empty: true }), [text]);
  return (
    <>
      {segments.map((seg, i) => {
        const cls = [
          seg.fg ? `${seg.fg}-fg` : "",
          seg.bg ? `${seg.bg}-bg` : "",
          seg.decorations?.includes("bold") ? "ansi-bold" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return cls ? (
          <span key={i} className={cls}>
            {seg.content}
          </span>
        ) : (
          <span key={i}>{seg.content}</span>
        );
      })}
    </>
  );
}
