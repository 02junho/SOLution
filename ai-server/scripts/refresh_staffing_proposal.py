"""가영 협의안과 별도 급여 연결 예제 재생성. 통계는 합성값이며 SimPy를 실행하지 않습니다."""
import json,sys
from copy import deepcopy
from pathlib import Path
r=Path(__file__).resolve().parents[2]; d=r/'data/demo/operation/staffing_proposal';d.mkdir(exist_ok=True)
def write(n,x):(d/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def employee(staff,role,support,start='07:00',end='19:00'):
 return dict(staff_id=staff,primary_role=role,can_support=support,start_time=start,end_time=end)
ga=[]
for key in ['CURRENT','ALT_A','ALT_C']:
 es=[employee('A','ORDER',['MAKE'] if key=='ALT_A' else []),employee('B','MAKE',['ORDER'] if key=='ALT_A' else [])]
 if key=='ALT_C':es.append(employee('C','MAKE',['ORDER'],'11:00','14:00'))
 ga.append(dict(choice_key=key,staffing=dict(employees=es,peak_staff_count=3 if key=='ALT_C' else 2,total_staff_hours=27 if key=='ALT_C' else 24)))
write('ga_young_staffing_only.json',{'staffing_schema_version':'operation.staffing.employees.v1-proposal','choices':ga,'note':'가영 공유 배치 초안을 재현한 합성 계약 예제. A/B의 소유자·시급·휴게가 없어 급여 계산 입력이 아님.'})
# Payroll pipeline example is separate, with explicit owner/wage/time assumptions.
original=json.loads((r/'data/demo/operation/input.json').read_text(encoding='utf-8'));body=deepcopy(original)
body['assumptions_version']='demo.staffing-review.v1'
body['labor']['workers']=[dict(worker_key='A',is_owner=True,is_minor=False,hourly_wage_krw=None),dict(worker_key='B',is_owner=False,is_minor=False,hourly_wage_krw=10320),dict(worker_key='C',is_owner=False,is_minor=False,hourly_wage_krw=10320)]
body['labor']['monthly_projection']['worker_days_per_week']={'B':5,'C':5}
plans=[]; choices=[]
for key in ['CURRENT','ALT_A','ALT_C']:
 es=[employee('A','ORDER',[]),employee('B','MAKE',[],'10:00','19:00')]
 if key=='ALT_A':
  es=[employee('A','ORDER',[],'07:00','11:00'),employee('A','ORDER',['MAKE'],'11:00','14:00'),employee('A','ORDER',[],'14:00','19:00'),employee('B','MAKE',[],'10:00','11:00'),employee('B','MAKE',['ORDER'],'11:00','14:00'),employee('B','MAKE',[],'14:00','19:00')]
 if key=='ALT_C':es.append(employee('C','MAKE',['ORDER'],'11:00','14:00'))
 shifts=[dict(worker_key=e['staff_id'],start_time=e['start_time'],end_time=e['end_time'],task_code=e['primary_role'],primary_role=e['primary_role'],can_support=e['can_support'],breaks=[]) for e in es]
 plans.append(dict(choice_key=key,shifts=shifts))
 choices.append(dict(choice_key=key,staffing=dict(employees=es,peak_staff_count=3 if key=='ALT_C' else 2,total_staff_hours=24 if key=='ALT_C' else 21)))
body['labor']['plans']=plans
write('input.json',body)
# Reuse statistics only as a labelled protocol fixture, never an actual SimPy run.
sim=json.loads((r/'data/demo/operation/compare_response.json').read_text(encoding='utf-8')); data=sim['data']
old=data.pop('results',data.pop('plans',[]));data.pop('staffing',None)
for i,choice in enumerate(choices):
 choice.update({k:v for k,v in old[i].items() if k!='choice_key'})
 choice['closing']=None
write('compare_response.json',sim | {'data':data | {'choices':choices,'staffing_schema_version':'operation.staffing.employees.v1-proposal','request_key':'staffing-review:simulation'}})
write('simulation_request.json',body['simulation'] | dict(session_id=520001,input_version_id=530001,result_id=7001,request_key='staffing-review:simulation',staffing_schema_version='operation.staffing.employees.v1-proposal',choices=[{k:v for k,v in c.items() if k in ['choice_key','staffing']} for c in choices]))
sys.path.insert(0,str(r/'ai-server'))
from app.schemas.labor import ScheduleRequest,CostRequest
from app.tools.labor.service import create_schedule,calculate_cost
context=dict(session_id=520001,input_version_id=530001,business_date=body['business_date'],workers=body['labor']['workers'])
schedule_body=context|{k:v for k,v in body['labor'].items() if k in ['plans','auto_break','avoid_break_windows','timezone','rule_policy_version']}
roster=create_schedule(ScheduleRequest.model_validate(schedule_body));assert roster.status=='ok',roster
cost_body=context|{k:body[k] for k in ['wage_year','assumptions_version']}|{k:body['labor'][k] for k in ['cost_options','monthly_projection']}
cost_body['plans']=[dict(choice_key=p['choice_key'],shifts=p['schedule']) for p in roster.data['plans']]
cost=calculate_cost(CostRequest.model_validate(cost_body));assert cost.status=='ok',cost
write('schedule_request.json',schedule_body);write('schedule_response.json',roster.model_dump(mode='json'));write('cost_request.json',cost_body);write('expected_cost.json',cost.model_dump(mode='json'))
print([(p['choice_key'],p['cash_cost_krw'],p['additional_cash_cost_krw']) for p in cost.data['plans']])
