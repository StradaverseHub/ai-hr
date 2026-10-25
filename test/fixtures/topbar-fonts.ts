/** Match next/font's class-based variables, so the Monolith theme can override Classic's fonts. */
export async function installTopbarFonts(): Promise<() => void> {
  const assets = [
    ['TopbarJakarta', new URL('./topbar-fonts/jakarta-latin.woff2', import.meta.url).href, '200 800'],
    ['TopbarGeistMono', new URL('./topbar-fonts/geist-mono-latin.woff2', import.meta.url).href, '100 900'],
    ['TopbarDMMono', new URL('./topbar-fonts/dm-mono-latin-400.woff2', import.meta.url).href, '400'],
    ['TopbarDMMono', new URL('./topbar-fonts/dm-mono-latin-500.woff2', import.meta.url).href, '500'],
    ['TopbarSchibsted', new URL('../../app/fonts/schibsted-grotesk/SchibstedGrotesk-Variable.ttf', import.meta.url).href, '400 600'],
  ];
  const faces = await Promise.all(assets.map(async ([family, url, weight]) => {
    const face = new FontFace(family, `url(${url})`, { weight, style: 'normal' });
    await face.load();
    document.fonts.add(face);
    return face;
  }));
  const variables = document.createElement('style');
  variables.textContent = `.topbar-font-fixture {
    --font-jakarta: TopbarJakarta;
    --font-geist-mono: TopbarGeistMono;
    --font-schibsted: TopbarSchibsted;
    --font-dm-mono: TopbarDMMono;
  }`;
  document.head.append(variables);
  document.documentElement.classList.add('topbar-font-fixture');
  await document.fonts.ready;
  return () => {
    document.documentElement.classList.remove('topbar-font-fixture');
    variables.remove();
    for (const face of faces) document.fonts.delete(face);
  };
}
