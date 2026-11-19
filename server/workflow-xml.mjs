import {z} from 'zod';
import {SaxesParser} from 'saxes';
import {AppError} from './model.mjs';

const bytes=262144,reserved=['__proto__','prototype','constructor'];
const source=z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/).refine(v=>!v.split('.').some(s=>reserved.includes(s)));
const name=z.string().min(1).max(256).regex(/^[^\s<>&"'=\/?!\[\]]+$/u),value=z.string().max(bytes),children=z.array(z.unknown()).max(5000);
const documentSchema=z.object({type:z.literal('document'),standalone:z.boolean().optional(),children}).strict();
const nodeSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('element'),name,attributes:z.array(z.object({name,value}).strict()).max(100),children}).strict(),
 ...['text','cdata','comment'].map(type=>z.object({type:z.literal(type),value}).strict()),
 z.object({type:z.literal('instruction'),name,value}).strict(),
]);
export function validateXml(raw){
 const result=z.object({operation:z.enum(['parse','serialize']),source}).safeParse(raw);
 if(!result.success)throw new AppError(400,'XML needs Parse XML or Create XML and a plain source path without prototype keys.');
 return result.data;
}
function parseXml(xml){
 if(typeof xml!=='string'||!xml.trim()||Buffer.byteLength(xml)>bytes)throw new AppError(400,'Parse XML needs nonempty UTF-8 XML text, up to 256 KiB.');
 const document={type:'document',children:[]},stack=[document];let elements=0,nodes=0;
 const append=node=>{
  if(++nodes>5000)throw new AppError(400,'XML exceeds 5,000 content nodes. Split the document first.');
  const list=stack.at(-1).children,last=list.at(-1);
  if(['text','cdata'].includes(node.type)&&last?.type===node.type)last.value+=node.value;else list.push(node);
 };
 const parser=new SaxesParser({xmlns:true,defaultXMLVersion:'1.0',forceXMLVersion:true});
 parser.on('error',()=>{throw new AppError(400,'XML is not well formed. Check the root, matching tags, names, namespaces and entities.');});
 parser.on('doctype',()=>{throw new AppError(400,'XML DTDs and custom or external entities are not supported. Use ordinary text or predefined XML entities.');});
 parser.on('xmldecl',d=>{
  if(d.version!=='1.0'||d.encoding&&!/^utf-8$/i.test(d.encoding))throw new AppError(400,'Use XML 1.0 with UTF-8 encoding.');
  if(d.standalone!==undefined)document.standalone=d.standalone==='yes';
 });
 parser.on('opentag',tag=>{
  if(++elements>1000||stack.length>32)throw new AppError(400,'XML supports up to 1,000 elements and 32 element levels. Split the document first.');
  const attributes=Object.values(tag.attributes).map(a=>({name:a.name,value:a.value}));
  if(tag.name.length>256||attributes.length>100||attributes.some(a=>a.name.length>256))throw new AppError(400,'XML names support 256 characters and each element supports 100 attributes.');
  const node={type:'element',name:tag.name,attributes,children:[]};append(node);stack.push(node);
 });
 parser.on('closetag',()=>stack.pop());
 parser.on('text',value=>append({type:'text',value}));
 parser.on('cdata',value=>append({type:'cdata',value}));
 parser.on('comment',value=>append({type:'comment',value}));
 parser.on('processinginstruction',p=>{if(p.target.length>256)throw new AppError(400,'XML names support 256 characters.');append({type:'instruction',name:p.target,value:p.body});});
 parser.write(xml).close();
 const root=document.children.find(n=>n.type==='element');
 return {document,root:root.name,elements};
}
const escapeText=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\r','&#13;');
function createXml(raw){
 const parsed=documentSchema.safeParse(raw);
 if(!parsed.success)throw new AppError(400,'Create XML needs an ordered document tree with type document and a children array, such as last.document from Parse XML.');
 const document=parsed.data,parts=[];let size=0,nodes=0,elements=0;
 const push=text=>{size+=Buffer.byteLength(text);if(size>bytes)throw new AppError(400,'XML output exceeds 256 KiB. Split the document first.');parts.push(text);};
 const emit=(raw,depth)=>{
  if(++nodes>5000)throw new AppError(400,'XML supports up to 5,000 content nodes. Split the document first.');
  const checked=nodeSchema.safeParse(raw);
  if(!checked.success)throw new AppError(400,'Check XML tree node types, names, attribute arrays and string values.');
  const n=checked.data;
  if(n.type==='element'){
   if(depth>32)throw new AppError(400,'XML supports up to 32 element levels. Split the document first.');
   if(++elements>1000)throw new AppError(400,'XML supports up to 1,000 elements. Split the document first.');
   push('<'+n.name);
   for(const a of n.attributes)push(' '+a.name+'="'+escapeText(a.value).replaceAll('"','&quot;').replaceAll('\t','&#9;').replaceAll('\n','&#10;')+'"');
   push('>');for(const child of n.children)emit(child,depth+1);push('</'+n.name+'>');
  }else if(n.type==='text')push(escapeText(n.value));
  else if(n.type==='cdata')push('<![CDATA['+n.value.replaceAll(']]>',']]]]><![CDATA[>')+']]>');
  else if(n.type==='comment'){
   if(n.value.includes('--')||n.value.endsWith('-'))throw new AppError(400,'XML comments cannot contain -- or end with a hyphen.');
   push('<!--'+n.value+'-->');
  }else{
   if(n.value.includes('?>'))throw new AppError(400,'XML instruction content cannot contain ?>.');
   push('<?'+n.name+(n.value?' '+n.value:'')+'?>');
  }
 };
 push('<?xml version="1.0" encoding="UTF-8"'+(document.standalone===undefined?'':' standalone="'+(document.standalone?'yes':'no')+'"')+'?>');
 for(const child of document.children)emit(child,1);
 if(Buffer.byteLength(JSON.stringify(raw))>bytes)throw new AppError(400,'XML tree input exceeds 256 KiB. Split the document first.');
 const xml=parts.join(''),validated=parseXml(xml);
 return {xml,root:validated.root,elements:validated.elements};
}
export function executeXml(raw,input){
 const d=validateXml(raw),output=d.operation==='parse'?parseXml(input):createXml(input);
 // ponytail: bounded in-memory XML in the shared worker; stream larger documents from object storage in separate jobs.
 if(Buffer.byteLength(JSON.stringify(output))>bytes)throw new AppError(400,'XML output exceeds 256 KiB. Split the document first.');
 return output;
}
