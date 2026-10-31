/**
 * Relivaro brand marks and colours for generated reports. The SVG markup is a trusted constant from the brand masters
 * in `branding/` (never derived from analysed content).
 */
export const BRAND = {
  light: { brand: '3346d3', ink: '2a3ab8', soft: 'eef0fd' },
  dark: { brand: '8593ff', ink: 'a9b3ff', soft: '1c2140' },
  /** Symbol, drawn in `currentColor`-independent brand colours; viewBox is square. */
  symbol:
    '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--brand)"/></svg>',
  /** Outlined wordmark in `currentColor`. */
  wordmark:
    '<svg class="word" viewBox="0 0 80 17" aria-hidden="true"><text x="0" y="14" font-size="16" font-weight="700" fill="currentColor">Relivaro</text></svg>',
};
