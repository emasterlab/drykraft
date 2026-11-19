import { z } from 'zod';
import { stepSchema } from './outreach.mjs';

const label=z.string().trim().min(1).max(60).refine(v=>!/[\r\n]/.test(v),'Use a single-line label.');
export const invoiceTemplateSchema=z.object({
  title:label.default('Invoice'),bill_to_label:label.default('Bill to'),payment_label:label.default('Payment instructions'),notes_label:label.default('Notes'),
  payment_instructions:z.string().max(2000).default(''),notes:z.string().max(2000).default(''),
  footer:z.string().max(140).refine(v=>!/[\r\n]/.test(v),'Use a single-line footer.').default(''),accent:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#bf3d05'),
}).strict();
const name=z.string().trim().min(1).max(100);
const entry=(kind,content)=>z.object({name,kind:z.literal(kind),content,archived:z.boolean().default(false)}).strict();
export const templateInputSchema=z.discriminatedUnion('kind',[
  entry('invoice',invoiceTemplateSchema),
  entry('expense',z.object({vendor:z.string().max(2000).default(''),category:z.string().max(2000).default(''),notes:z.string().max(2000).default('')}).strict()),
  entry('email',stepSchema.pick({subject:true,body:true}).strict().refine(v=>v.subject.trim()&&v.body.trim(),'Enter a subject and message.')),
  entry('sms',stepSchema.pick({body:true,variables:true}).strict().refine(v=>Object.keys(v.variables).length<=40,'Use at most40 SMS variables.').refine(v=>v.body.trim()||Object.keys(v.variables).length,'Enter a message or template variables.')),
  entry('voice',stepSchema.pick({assistantId:true,dialerId:true}).strict().refine(v=>v.assistantId.trim()&&v.dialerId.trim(),'Enter a QCall assistant and dialer.')),
  entry('whatsapp',stepSchema.pick({template:true,language:true,parameters:true}).strict().refine(v=>v.template.trim()&&v.language.trim(),'Enter an approved template name and language.')),
]);
