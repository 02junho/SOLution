"""바쁜 카페 예시(가상): 아침 8~11시와 점심 11~14시가 둘 다 붐비는 매장, 4주 POS 판매 내역(xlsx).
멘토링에서 들은 근처 바쁜 카페 모양(아침 8~11시 피크, 직원 4~5명)을 흉내 낸 가정 데이터다."""
import datetime as dt, random
from pathlib import Path
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]  # 저장소 맨 위
OUT = ROOT / "frontend" / "public" / "samples" / "busy_cafe_pos.xlsx"
NOTE = "가상 매장 데이터(시연용). 아침(8~11시)과 점심(11~14시)이 모두 붐비는 바쁜 카페를 가정했어요. 시간대 모양·주문 수·메뉴 구성은 모두 가정."
rng = random.Random(20261122)
HOURLY = {7: 10, 8: 34, 9: 38, 10: 30, 11: 22, 12: 36, 13: 30, 14: 12, 15: 11, 16: 10, 17: 8, 18: 6, 19: 4}
WEEKDAY_FACTOR = [1.0, 1.02, 1.0, 1.03, 0.98, 0.62, 0.5]
MENUS = [("아메리카노(ICE)", 34), ("HOT 아메리카노", 6), ("콜드브루", 6), ("카페라떼 ICE", 16), ("따뜻한 카페라떼", 5),
         ("바닐라빈 라떼", 6), ("아인슈페너", 4), ("말차라떼", 5), ("딸기 요거트 스무디", 4), ("말차 프라페", 3),
         ("자몽에이드", 3), ("얼그레이 밀크티", 2), ("버터 크로플", 3), ("오늘의 시그니처", 3)]
names, weights = zip(*MENUS)
start = dt.date(2026, 10, 19)
wb = Workbook(); ws = wb.active; ws.title = "판매"
ws.append([NOTE]); ws.append([])
ws.append(["영수증번호", "판매일자", "판매시간", "메뉴명", "수량", "금액", "상태"])
rows = 0
for i in range(28):
    day = start + dt.timedelta(days=i)
    f = WEEKDAY_FACTOR[day.weekday()]
    for h, n in HOURLY.items():
        count = max(0, round(rng.gauss(n * f, (n * f) ** 0.5)))
        for _ in range(count):
            t = dt.time(h, rng.randrange(60), rng.randrange(60))
            ws.append([f"R{rng.randrange(10**6, 10**7)}", day, t.strftime("%H:%M"), rng.choices(names, weights)[0], 1, 5000, "정상"])
            rows += 1
for row in ws.iter_rows(min_row=4, min_col=2, max_col=2):
    row[0].number_format = "yyyy-mm-dd"
wb.save(OUT)
print(rows, rows / 28)
