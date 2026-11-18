/** Reuse only immutable locale/options formatters; never retain dates, clocks or formatted values. */
const formatters=new Map<string,Intl.DateTimeFormat>();
const MAX_FORMATTERS=64;
export function dateTimeFormatter(locale:string,options:Readonly<Intl.DateTimeFormatOptions>):Intl.DateTimeFormat{
 const key=JSON.stringify([locale,Object.entries(options).sort(([a],[b])=>a<b?-1:a>b?1:0)]);
 const existing=formatters.get(key);if(existing)return existing;
 const formatter=new Intl.DateTimeFormat(locale,options);
 if(formatters.size>=MAX_FORMATTERS)formatters.delete(formatters.keys().next().value!);
 formatters.set(key,formatter);return formatter;
}
