"""추천 근무표 가게 파일 읽기 테스트용 판매 파일 2개(가상 매장, 11/2~11/8 한 주).

- cancel_yn.csv: "취소여부" 열에 Y(취소)가 섞인 파일. Y 줄은 빼고 센다.
- note_line_tab.csv: 첫 줄이 "조회 기간: …" 설명이고 그 아래부터 탭으로 나뉜 표. 시각은 093000(HHMMSS) 모양.
두 파일은 같은 판매 줄로 만들어, 취소만 빠지면 하루 주문 수가 조금 적게 나와야 한다.
"""
import datetime as dt
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # 저장소 맨 위
OUT = ROOT / "data" / "demo" / "operation" / "store_files"
rng = random.Random(7)
MENUS = [("아이스 아메리카노", 0.45), ("아이스 카페라떼", 0.2), ("핫 아메리카노", 0.1),
         ("아이스 바닐라라떼", 0.1), ("블루베리 요거트 스무디", 0.08), ("레몬에이드", 0.07)]
SHAPE = {7: 5, 8: 12, 9: 10, 10: 7, 11: 12, 12: 16, 13: 13, 14: 7, 15: 6, 16: 6, 17: 5, 18: 3}  # 시간대별 주문 수(평일)
WEEKEND = 0.6  # 주말은 평일의 60%

rows = []
for d in range(7):
    day = dt.date(2026, 11, 2) + dt.timedelta(days=d)
    scale = 1.0 if d < 5 else WEEKEND
    for hour, n in SHAPE.items():
        for _ in range(round(n * scale)):
            at = dt.datetime(day.year, day.month, day.day, hour, rng.randrange(60), rng.randrange(60))
            rows.append((at, rng.choices([m for m, _ in MENUS], [w for _, w in MENUS])[0]))
rows.sort()

OUT.mkdir(parents=True, exist_ok=True)
lines = ["거래일시,취소여부,품목,수량,금액"]
for at, menu in rows:
    lines.append(f"{at:%Y-%m-%d %H:%M:%S},{'Y' if rng.random() < 0.03 else 'N'},{menu},1,4500")
(OUT / "cancel_yn.csv").write_text("\n".join(lines) + "\n", encoding="utf-8-sig")

lines = ['"조회 기간: 2026-11-02, 2026-11-08 (카드 승인 내역, 예시)"', "승인일자\t승인시간\t품목\t승인금액"]
for at, menu in rows:
    lines.append(f"{at:%Y-%m-%d}\t{at:%H%M%S}\t{menu}\t4500")
(OUT / "note_line_tab.csv").write_text("\n".join(lines) + "\n", encoding="utf-8-sig")
print(len(rows), "줄씩 만들었어요:", OUT)
