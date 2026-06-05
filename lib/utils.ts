/** Join truthy class names. A tiny `clsx` for this starter. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** First two initials of a name, uppercased. "Aisyah Rahman" -> "AR". */
export function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Format an ISO date as e.g. "12 Mar 2024". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Whole-month tenure rendered as "3y 2m" / "7m". */
export function tenure(iso: string): string {
  const start = new Date(iso);
  const now = new Date();
  let months =
    (now.getFullYear() - start.getFullYear()) * 12 +
    (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  months = Math.max(0, months);
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${rem}m`;
  if (rem === 0) return `${years}y`;
  return `${years}y ${rem}m`;
}
