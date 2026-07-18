const VARIANT_PREFIX = /^(?:sm|md|lg|xl|2xl|dark|hover|focus|focus-visible|focus-within|active|disabled|visited|checked|group-hover|group-focus|peer-checked|aria-[a-z0-9-]+|data-\[[^\]]+\]):/;

const UTILITY_FAMILY = /^(?:container|sr-only|not-sr-only|visible|invisible|collapse|static|fixed|absolute|relative|sticky|inset|inset-[xy]|top|right|bottom|left|z|order|col|col-span|col-start|col-end|row|row-span|row-start|row-end|float|clear|m[trblxy]?|p[trblxy]?|space-[xy]|box|block|inline|inline-block|flow-root|flex|inline-flex|grid|inline-grid|contents|hidden|aspect|size|h|min-h|max-h|w|min-w|max-w|basis|grow|shrink|table|caption|border-collapse|border-separate|origin|translate-[xy]|rotate|skew-[xy]|scale|transform|animate|cursor|touch|select|resize|scroll|snap|list|appearance|columns|break|auto-cols|grid-cols|auto-rows|grid-rows|grid-flow|gap|justify|content|items|self|place-content|place-items|place-self|overflow|overscroll|truncate|whitespace|text|align|font|tracking|leading|line-clamp|decoration|underline|uppercase|lowercase|capitalize|normal-case|ordinal|slashed-zero|lining-nums|oldstyle-nums|proportional-nums|tabular-nums|diagonal-fractions|stacked-fractions|bg|from|via|to|rounded|border|divide|outline|ring|shadow|opacity|mix-blend|bg-blend|object|fill|stroke|blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia|backdrop|transition|duration|ease|delay|will-change|accent|caret|pointer-events)(?:$|[-/\[])/;

/** Recognize utility syntax without treating every valid kebab-case BEM block as a utility. */
export function isUtilityClass(className: string): boolean {
  let candidate = className;
  while (VARIANT_PREFIX.test(candidate)) candidate = candidate.replace(VARIANT_PREFIX, "");
  if (candidate === "content") return false;
  return /^u-\d+$/.test(candidate) || UTILITY_FAMILY.test(candidate) || /^-?(?:m|p|inset|top|right|bottom|left|translate-[xy])-/.test(candidate);
}
