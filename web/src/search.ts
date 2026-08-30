export function validateSearch(query:string,datasets:string[],topK:number){
  if(!query.trim()) return 'Enter a description to search'
  if(!datasets.length) return 'Select at least one dataset'
  if(![12,24,48].includes(topK)) return 'Choose 12, 24, or 48 results'
  return ''
}
export const nextVisibleCount=(current:number,total:number)=>Math.min(current+24,total)
export function errorMessage(status:number,detail?:string){
  if(status===503)return detail||'The search index is not ready. Check the service and active index.'
  if(status===400||status===422)return detail||'Review your description and settings.'
  if(status>=500)return 'The search service failed. Your description and settings have been preserved.'
  return detail||'Search could not be completed. Check the service and try again.'
}
