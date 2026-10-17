const {start}=require('./hot-pools.cjs');
function overview(pending,scan,config,now=Date.now()){
 const rows=pending.filter(x=>['note','comment'].includes(x.type));
 const cutoff=start(config.recent_priority_calendar_days||3,now);
 const recent=rows.filter(x=>{const t=x.comment?.published_at_ms||x.published_at_ms;return Number.isFinite(t)&&t>=cutoff&&t<=now;}).length;
 const unknown=rows.filter(x=>!Number.isFinite(x.comment?.published_at_ms||x.published_at_ms)).length;
 const planned=scan.search_plan||[],executed=scan.searches||[];
 const missing=planned.filter(p=>!executed.some(s=>s.keyword===p.keyword&&s.sort_by===p.sort_by)).length;
 const failed=executed.filter(s=>s.error).length,detailFailed=(scan.notes||[]).filter(n=>n.error).length;
 const coverage=scan.maintenance?'本轮复用既有采集结果，没有重新搜索。':`搜索未执行${missing}项、搜索失败${failed}项、详情失败${detailFailed}帖；未读候选${scan.unread_candidates_pending??'未统计'}帖。${scan.complete===false?'本轮覆盖未完成。':''}`;
 return `### 时效与覆盖\n\n近期新增${recent}条（近${config.recent_priority_calendar_days||3}个北京时间自然日）｜历史补充${rows.length-recent-unknown}条${unknown?`｜发布时间未知${unknown}条`:''}。按本次首次推送记录统计，不代表刚发布，也不等于独立客户人数。\n\n尚未覆盖：${coverage}\n\n实际推送时间以本轮运行记录中的群回执确认时间为准；文档先保存，取得群回执后补记。`;
}
module.exports={overview};
