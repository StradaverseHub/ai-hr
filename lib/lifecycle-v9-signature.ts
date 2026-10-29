/** Bounded signature values shared by the browser-independent domain and PDF export. */
export function validV9SignatureValue(method: 'typed' | 'drawn', value: string): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (method === 'typed') return [...value].length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
  if (method !== 'drawn' || value.length > 500000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = Uint8Array.from(atob(value.slice(value.indexOf(',') + 1, value.indexOf(',') + 45)), character => character.charCodeAt(0));
    if (bytes.length < 24 || ![137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((byte, index) => bytes[index] === byte)) return false;
    const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
    return width >= 1 && width <= 2048 && height >= 1 && height <= 1024 && width * height <= 2097152;
  } catch { return false; }
}
