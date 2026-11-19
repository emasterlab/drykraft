export const filterLabels = { eq:'is', ne:'is not', contains:'contains', not_contains:'does not contain', gt:'is greater than', gte:'is at least', lt:'is less than', lte:'is at most', empty:'is empty', not_empty:'is not empty' };
export function filterOperators(field) {
  if(!field || ['json','relation'].includes(field.type))return [];
  if(field.key==='currency')return ['eq','ne','empty','not_empty'];
  if(['number','currency','date'].includes(field.type))return ['eq','ne','gt','gte','lt','lte','empty','not_empty'];
  if(field.type==='multi_select')return ['contains','not_contains','empty','not_empty'];
  if(['boolean','select','user'].includes(field.type))return ['eq','ne','empty','not_empty'];
  return ['eq','ne','contains','not_contains','empty','not_empty'];
}
