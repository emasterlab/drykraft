import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {pool,tenantTransaction,event} from '../server/db.mjs';
import {saveRecord,connectExistingLead,resolveRecord} from '../server/model.mjs';

// Historical repair is deliberately separate from a user save: preserve issued financial
// snapshots and mark only this transaction's new events as historical, without replaying
// customer campaigns/workflows. Exact-name ambiguity is reported for a human to resolve.
export async function linkExistingRecords({workspaceId=null}={}){
 const report={workspaces:0,updated:{people:0,leads:0,deals:0,finance:0},skipped:[],historical_events_only:true};
 const tenants=(await pool.query('SELECT id FROM workspaces WHERE ($1::uuid IS NULL OR id=$1) ORDER BY id',[workspaceId])).rows;
 for(const {id:tenant} of tenants){
  report.workspaces++;
  for(const key of ['people','leads','deals','invoices','expenses']){
   let cursor=null;
   for(;;){
    const page=await tenantTransaction(tenant,async c=>(await c.query('SELECT id FROM records WHERE object_key=$1 AND merged_into IS NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[key,cursor])).rows);
    for(const {id} of page){
     try{
      const changed=await tenantTransaction(tenant,async c=>{
       const record=await resolveRecord(c,id,key,true);let changed=false;
       if(key==='leads'){
        const before=(await c.query("SELECT id FROM records WHERE object_key='deals' AND data->>'lead_id'=$1 LIMIT 1",[id])).rowCount;
        const result=await connectExistingLead(c,tenant,record.created_by,id);
        changed=!before || result.lead.version!==record.version;
       }else if(['people','deals'].includes(key)){
        const data={...record.data};
        if(key==='deals' && !data.pipeline_id){
         const pipeline=(await c.query('SELECT * FROM pipelines ORDER BY name,id LIMIT 1 FOR SHARE')).rows[0];
         if(!pipeline?.stages.length)throw Error('No Sales pipeline is available.');
         const stage=pipeline.stages.find(s=>data.status==='Won'?s.id==='won':s.id!=='won') || pipeline.stages[0];
         Object.assign(data,{pipeline_id:pipeline.id,stage:stage.id,probability:data.probability ?? stage.probability});
        }
        if(!data.company_id && (data.company || data.person_id) || !isDeepStrictEqual(data,record.data)){
         const saved=await saveRecord(c,tenant,record.created_by,key,data,id,record.version);
         changed=!isDeepStrictEqual(saved.data,record.data);
        }
       }else if(key==='invoices' && !record.data.company_id){
        let companyId;
        for(const [field,target] of [['deal_id','deals'],['contact_id','people']])if(!companyId && record.data[field])companyId=(await resolveRecord(c,record.data[field],target)).data.company_id;
        if(companyId){
         const company=await resolveRecord(c,companyId,'companies');
         const inserted=await c.query("INSERT INTO record_links(tenant_id,source_id,target_id,relation) VALUES($1,$2,$3,'company') ON CONFLICT DO NOTHING",[tenant,id,company.id]);
         changed=!!inserted.rowCount;
         if(changed)await event(c,tenant,record.created_by,'crm.relationship.changed',key,id,{record,association:'company',before:null,after:company.id,target_object:'companies',historical:true});
        }
       }
       await c.query("UPDATE outbox SET published_at=now() WHERE xmin=pg_current_xact_id()::text::xid AND published_at IS NULL");
       return changed;
      });
      if(changed)report.updated[['invoices','expenses'].includes(key)?'finance':key]++;
     }catch(error){report.skipped.push({workspace_id:tenant,object:key,id,reason:error.status && error.status<500?error.message:error.code || 'This record needs review before linking.'});}
    }
    if(page.length<100)break;cursor=page.at(-1).id;
   }
  }
 }
 return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await linkExistingRecords()));}finally{await pool.end();}
}
