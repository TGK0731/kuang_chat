import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import 'highlight.js/styles/github-dark.css';

const MarkdownRenderer = ({ content }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeHighlight]}
      components={{
        code({ node, inline, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';
          
          if (inline) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          
          return (
            <code className={`hljs language-${language}`} {...props}>
              {children}
            </code>
          );
        },
        pre({ children }) {
          return <div className="code-block">{children}</div>;
        },
        text({ children, ...props }) {
          const str = String(children);
          const parts = str.split(/(\[\d+\])/g);
          if (parts.length <= 1) return <>{children}</>;
          return (
            <>
              {parts.map((part, i) => {
                const m = part.match(/^\[(\d+)\]$/);
                if (m) {
                  return (
                    <sup key={i} className="citation-marker" data-cite={m[1]}>
                      {part}
                    </sup>
                  );
                }
                return <span key={i}>{part}</span>;
              })}
            </>
          );
        }
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

export default MarkdownRenderer;

function myPromiseAll(promises) {
  return new Promise((resolve,reject)=>{
    if(!promises.length){
      resolve([])
    }
    let results = []
    let count = 0
    promises.foreach(
      (promise,index)=>{
        promise.resolve(p).then(val=>{
          results[index] = val

          count++
          if(count===promises.length){
            resolve(results)
          }
        },reject)
      }
    )
  })
}

class EventEmitter {
  constructor() {
    this.listeners = {};
  }
  on(e,fn){(this.listeners[e] = this.listeners[e] || []).push(fn)}
  once(e,fn){
    const wrap=(...args)=>{
      fn(...args)
      this.off(e,wrap)
    }
    this.on(e,wrap)
  }
  emit(e,...args){
    (this.listeners[e] || []).forEach(fn=>fn(...args))
  }
  off(e,fn){
    this.listeners[e] = this.listeners[e].filter(listener=>listener!==fn)
  }
}

function phaseUrl(url){
  const [path,queryStr]=url.split('?')
  const query={}
  queryStr?.split('&').forEach(kv=>{
    [k,v='']=kv.split('=')
    if(query[k])query[k]=[].concat(query[k],decodeURIComponentv)
    else query[k]=decodeURIComponent(v)
  })
  return{path,query}
}
function isEqual(a,b){
  if(a===b) return true
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    const keysA=Object.keys(a)
    const keysB=Object.keys(b)
    if(keysA.length!==keysB.length) return false
    return keysA.every(k=>isEqual(a[k],b[k]))
  } 
  return Number.isNaN(a)&&Number.isNaN(b)
}