"""신한카드 기반 상권 분포를 따르는 시연용 가상 매장 데이터 2개.

시간대 모양과 요일 비율은 서울시 상권분석서비스 추정매출(을지로입구역 커피-음료, 2024Q1~2026Q2, 신한카드 결제 기반)의
분기별 중앙값을 쓴다. 원본 시간대 안에서는 시간당 건수가 같다고 본다(1번 버전과 같은 가정). 하루 주문 수(평균 150건)와
메뉴 구성(엔진 기본 비중)은 가정이다. 매장 하나의 실제 거래가 아니다.
"""
import csv, math, random, datetime as dt
from pathlib import Path
from statistics import median
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]  # 저장소 맨 위
SRC = ROOT / "data" / "public" / "seoul_sales_euljiro_coffee_2024q1_2026q2.csv"
OUT = str(ROOT / "frontend" / "public" / "samples") + "/"
rows = [r for r in csv.DictReader(open(SRC, encoding="utf-8-sig"))
        if r["상권_코드_명"] == "을지로입구역" and r["서비스_업종_코드"] == "CS100010"]
assert len(rows) == 10
BANDS = [("시간대_06~11_매출_건수", 6, 11), ("시간대_11~14_매출_건수", 11, 14),
         ("시간대_14~17_매출_건수", 14, 17), ("시간대_17~21_매출_건수", 17, 21)]
rate = {}
for col, a, b in BANDS:
    per_hour = median(int(r[col]) / (b - a) for r in rows)
    for h in range(a, b):
        rate[h] = per_hour
OPEN, CLOSE = 7, 20
hours = list(range(OPEN, CLOSE))
total = sum(rate[h] for h in hours)
hour_share = {h: rate[h] / total for h in hours}
WD = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]
wd_share = [median(int(r[f"{d}_매출_건수"]) / sum(int(r[f"{x}_매출_건수"]) for x in WD) for r in rows) for d in WD]
s = sum(wd_share)
wd_factor = [w / s * 7 for w in wd_share]
DAILY = 150
NOTE = ("가상 매장 데이터(시연용). 시간대·요일 분포는 서울시 상권분석서비스 추정매출(을지로입구역 커피, 신한카드 결제 기반, "
        "2024Q1~2026Q2 분기 중앙값)을 따름. 하루 평균 150건과 메뉴 구성은 가정.")

rng = random.Random(20261121)
def poisson(lam):
    L, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= L:
            return k
        k += 1
start = dt.date(2026, 10, 19)  # 월요일, 4주
days = [start + dt.timedelta(d) for d in range(28)]
def times(day):
    out = []
    for h in hours:
        lam = DAILY * wd_factor[day.weekday()] * hour_share[h]
        for _ in range(poisson(lam)):
            out.append(dt.datetime.combine(day, dt.time(h, rng.randrange(60), rng.randrange(60))))
    return sorted(out)

# 3) 승인 내역 형태(결제 시각·금액만), UTF-8 CSV
lines = []
for day in days:
    for t in times(day):
        lines.append([t.strftime("%Y-%m-%d %H:%M:%S"), f"{rng.randrange(10**7, 10**8)}", rng.choice([4500, 4500, 5000, 5500, 6000, 9500]), "승인"])
for r in rng.sample(lines, 20):
    lines.append([r[0], r[1], -r[2], "취소"])
lines.sort(key=lambda r: r[0])
with open(OUT + "shinhan_pattern_approvals.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow([NOTE])
    w.writerow(["거래일시", "승인번호", "결제금액", "거래구분"])
    w.writerows(lines)

# 4) POS 형태(날짜·시간·메뉴·수량), xlsx. 메뉴 이름은 실제 카페 메뉴판처럼 다양하게(카탈로그에 없는 이름 포함).
# 유형으로 묶으면 엔진 기본 5종 비중과 비슷하다(커피 48, 우유 커피 30, 커피 없는 라떼 12, 블렌더 10 근처). 디저트도 섞었다.
MENUS = [("아메리카노(ICE)", 36), ("콜드브루", 8), ("HOT 아메리카노", 4), ("카페라떼 ICE", 15), ("아인슈페너", 6),
         ("바닐라빈 라떼", 4), ("따뜻한 카페라떼", 5), ("말차라떼", 7), ("흑임자라떼", 3), ("얼그레이 밀크티", 2),
         ("자몽에이드", 3), ("딸기 요거트 스무디", 4), ("말차 프라페", 3), ("버터 크로플", 3), ("바스크 치즈케이크", 2),
         ("오늘의 시그니처", 2)]
names, weights = zip(*MENUS)
wb = Workbook(); ws = wb.active; ws.title = "판매"
ws.append([NOTE]); ws.append([])
ws.append(["영수증번호", "판매일자", "판매시간", "메뉴명", "수량", "금액", "상태"])
for day in days:
    for t in times(day):
        ws.append([f"R{rng.randrange(10**6, 10**7)}", day, t.strftime("%H:%M"), rng.choices(names, weights)[0], 1, 5000, "정상"])
for row in ws.iter_rows(min_row=4, min_col=2, max_col=2):
    row[0].number_format = "yyyy-mm-dd"
wb.save(OUT + "shinhan_pattern_pos.xlsx")
print("hour share", {h: round(v * 100, 2) for h, v in hour_share.items()})
print("weekday factor", [round(x, 3) for x in wd_factor])
print(len(lines), ws.max_row)
