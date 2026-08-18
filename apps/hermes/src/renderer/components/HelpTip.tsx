// ---------------------------------------------------------------------------
// HelpTip — a tiny "?" badge that surfaces explanatory text on hover via the
// native title tooltip. Replaces always-on inline help paragraphs so the
// screen isn't crowded with documentation the user only occasionally needs.
// ---------------------------------------------------------------------------

export function HelpTip({ text }: { text: string }) {
  return (
    <span className="help-tip" title={text} role="img" aria-label="ヘルプ">
      ?
    </span>
  );
}
