import { bookNode } from './extract'

/** The same test the bookmarklet runs before sending (kept in sync by bookmarklet.test.ts). */
export const isBookCapture = (capture: { ld: unknown[] }): boolean => bookNode(capture) !== null

const BANNER = (color: string, text: string) =>
  `document.body.insertAdjacentHTML('afterbegin','<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${color};color:#fff;padding:16px;font:18px sans-serif;text-align:center">${text}</div>')`

export function bookmarkletSource(appUrl: string): string {
  const app = JSON.stringify(appUrl)
  const origin = JSON.stringify(new URL(appUrl).origin)
  return [
    '(function(){',
    `var A=${app},O=${origin},S=['review','reviews','offers','aggregateRating','brand'];`,
    "function st(o){if(Array.isArray(o))return o.map(st);if(o&&typeof o=='object'){var r={};for(var k in o){if(S.indexOf(k)>=0)continue;var v=o[k];r[k]=(k=='description'&&typeof v=='string')?v.slice(0,2000):st(v)}return r}return o}",
    'var ld=[];document.querySelectorAll(\'script[type="application/ld+json"]\').forEach(function(s){try{if(ld.length<20)ld.push(st(JSON.parse(s.textContent)))}catch(e){}});',
    "var meta={};document.querySelectorAll('meta[content]').forEach(function(m){var k=m.getAttribute('property')||m.getAttribute('name');if(k&&!(k in meta))meta[k]=String(m.content).slice(0,2000)});",
    "function book(v){if(Array.isArray(v)){for(var i=0;i<v.length;i++){var b=book(v[i]);if(b)return b}return null}if(v&&typeof v=='object'){if([].concat(v['@type']).indexOf('Book')>=0)return v;return book(v['@graph'])}return null}",
    `if(!book(ld)){${BANNER('#b91c1c', 'Not a book page — open the book itself')};return}`,
    'var c={url:location.href,title:String(document.title).slice(0,500),ld:ld,meta:meta};',
    "function hash(){location.href=A+'#capture='+encodeURIComponent(JSON.stringify(c))}",
    // closes only once the app answers; no answer (another host name, another route, a closed tab) falls back to the hash
    `if(window.opener&&!window.opener.closed){var ok=0;window.addEventListener('message',function(e){if(e.origin==O&&e.data&&e.data.type=='my-library/ack'&&!ok){ok=1;${BANNER('#16a34a', 'Sent to My Library ✓')};setTimeout(function(){window.close()},800)}});window.opener.postMessage({type:'my-library/capture',v:1,capture:c},O);setTimeout(function(){if(!ok)hash()},1500)}`,
    'else hash()',
    '})()',
  ].join('')
}

export const bookmarkletUrl = (appUrl: string): string => `javascript:${encodeURIComponent(bookmarkletSource(appUrl))}`
