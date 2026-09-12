type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"} aria-label="Aletheopsis">
      <span className="brand__glyph" aria-hidden="true">
        <img className="brand__image" src="/aletheopsis-mark.png" alt="" />
      </span>
      {!compact && (
        <span className="brand__wording">
          <strong>ALETHEOPSIS</strong>
        </span>
      )}
    </div>
  );
}
