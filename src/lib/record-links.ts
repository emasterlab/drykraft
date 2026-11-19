export function recordPath(key:string){
  return ['invoices','expenses'].includes(key)?`/finance/${key}`:key==='purchase_orders'?'/finance/purchase-orders':key==='deals'?'/sales/deals':['people','companies','leads','tasks'].includes(key)?`/crm/${key}`:`/crm/objects/${key}`
}
export const recordUrl=(key:string,id:string)=>`${recordPath(key)}?record=${encodeURIComponent(id)}`
export const newRecordUrl=(key:string,sourceKey:string,id:string)=>`${recordPath(key)}?new=1&source_key=${encodeURIComponent(sourceKey)}&source_id=${encodeURIComponent(id)}`
