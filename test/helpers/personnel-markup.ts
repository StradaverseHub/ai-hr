/** Compare the retained pre-registry form contract, allowing only declared binding metadata,
 * required-label decoration, default text types and HTML attribute order. Names, native requirements,
 * values, constraints, disabled states, options, captions and layout remain part of the comparison. */
export function personnelMarkupContract(markup: string): string {
  const template = document.createElement('template');
  template.innerHTML = markup;
  for (const star of template.content.querySelectorAll('label > span > span.ml-0\\.5.text-destructive[aria-label]')) {
    if (star.textContent?.trim() === '*') star.remove();
  }
  for (const element of template.content.querySelectorAll('*')) {
    element.removeAttribute('data-personnel-field');
    if (element.tagName === 'INPUT' && !element.hasAttribute('type')) element.setAttribute('type', 'text');
    const attributes = [...element.attributes].map(({name, value}) => [name, value] as const).sort(([a], [b]) => a.localeCompare(b));
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
    for (const [name, value] of attributes) element.setAttribute(name, value);
  }
  return template.innerHTML;
}

/** Required markers add a suffix, but must never permit a different field caption. */
export function personnelCaption(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '(?:\\s*\\*)?$');
}
