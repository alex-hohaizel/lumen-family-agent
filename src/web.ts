import {parseHTML,DOMParser} from 'linkedom';
import {safeRequest,publicURL,ToolError,type HTTPRequest} from './safe-http.js';
import {documentText} from './documents.js';

export function pageContent(html:string,url:string){
  const {document}=parseHTML(html);
  for(const node of document.querySelectorAll('script,style,svg,noscript,iframe,template'))node.remove();
  const links=[...document.querySelectorAll('a[href]')].map(a=>{try{return {text:(a.textContent || '').trim().slice(0,160),url:publicURL(new URL(a.getAttribute('href') || '',url).href).href};}catch{return null;}}).filter(Boolean).slice(0,60);
  const root=document.querySelector('main,article,[role=main]') || document.body || document.documentElement;
  const text=(root?.textContent || '').replace(/[\t ]+/g,' ').replace(/\n\s*\n\s*\n/g,'\n\n').trim().slice(0,20000);
  return {url,title:(document.querySelector('title')?.textContent || document.title || '').slice(0,250),text,links};
}
export async function readWeb(url:string,request:HTTPRequest=safeRequest){
  const r=await request(url);if(r.status>=400)throw new ToolError(`http_${r.status}`);
  const mime=r.headers['content-type'] || '';
  if(/application\/pdf/i.test(mime)||r.url.toLowerCase().split('?')[0]?.endsWith('.pdf'))return {url:r.url,text:await documentText(r.body,'page.pdf'),retrieved_at:new Date().toISOString(),content_is_untrusted:true};
  if(/text\/html|application\/xhtml/i.test(mime))return {...pageContent(r.body.toString('utf8'),r.url),retrieved_at:new Date().toISOString(),content_is_untrusted:true};
  if(/text\/|application\/(json|xml|rss|atom)/i.test(mime))return {url:r.url,text:r.body.toString('utf8').slice(0,20000),retrieved_at:new Date().toISOString(),content_is_untrusted:true};
  throw new ToolError('page_needs_document_reader');
}
export async function publicSearch(query:string,request:HTTPRequest=safeRequest){
  const target='https://html.duckduckgo.com/html/?q='+encodeURIComponent(query);let results:{title:string;url:string;snippet:string}[]=[];let provider='DuckDuckGo HTML';
  try{
    const r=await request(target,{maxBytes:1500000,timeout:15000});if(r.status!==200)throw new ToolError('search_unavailable');
    const {document}=parseHTML(r.body.toString('utf8'));
    for(const a of document.querySelectorAll('a.result__a')){
      try{const link=new URL(a.getAttribute('href') || '',target);const direct=link.searchParams.get('uddg') || link.href;results.push({title:(a.textContent || '').trim().slice(0,200),url:publicURL(direct).href,snippet:(a.closest('.result')?.querySelector('.result__snippet')?.textContent || '').trim().slice(0,500)});}catch{}
    }
  }catch{}
  if(!results.length){
    provider='Bing RSS';const r=await request('https://www.bing.com/search?format=rss&q='+encodeURIComponent(query),{maxBytes:1000000,timeout:15000});if(r.status!==200)throw new ToolError('search_unavailable');
    const document=new DOMParser().parseFromString(r.body.toString('utf8'),'text/xml');
    for(const item of document.querySelectorAll('item')){try{results.push({title:(item.querySelector('title')?.textContent || '').slice(0,200),url:publicURL(item.querySelector('link')?.textContent || '').href,snippet:(item.querySelector('description')?.textContent || '').slice(0,500)});}catch{}}
  }
  results=results.filter(r=>r.title&&r.url).slice(0,8);if(!results.length)throw new ToolError('search_no_verified_results');
  return {query,results,sources:results.map(r=>r.url),provider,searched:true,retrieved_at:new Date().toISOString(),content_is_untrusted:true};
}
