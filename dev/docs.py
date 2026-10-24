"""Synthetic flat A4 documents (1240 x 1754 px, 150 dpi) resembling audit fieldwork papers."""
import os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H = 1240, 1754
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
FONT = os.path.join(FONTS, "DejaVuSans.ttf")
BOLD = os.path.join(FONTS, "DejaVuSans-Bold.ttf")
SERIF = os.path.join(FONTS, "DejaVuSerif.ttf")
WORDS = ("audit fee computation statement account balance sales purchases payment voucher receipt invoice "
         "total amount ringgit company limited sdn bhd director bank deposit transfer cheque cash tax service "
         "charge interest period ended december march june september client schedule ledger journal entry "
         "debit credit opening closing reference date description quantity unit price discount net").split()


def font(path, size):
    return ImageFont.truetype(path, size)


def words(rng, n):
    return " ".join(rng.choice(WORDS) for _ in range(n))


def money(rng):
    return f"{rng.uniform(10, 99999):,.2f}"


def workpaper(rng):
    """Like John's: header block, a ruled time-cost table, a coefficient table, a fee table."""
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f, fb = font(FONT, 22), font(BOLD, 22)
    y = 110
    for lab, val in [("Client", "RS Primus Sdn Bhd"), ("Year/Period Ended", "31 December 2025"), ("Subject", "Audit fee computation")]:
        d.text((120, y), lab, font=f, fill="black"); d.text((560, y), ": " + val, font=f, fill="black"); y += 34
    y += 30
    d.text((120, y), "Actual time costs", font=fb, fill="black"); y += 50
    x_cols = [120, 640, 790, 960, 1120]
    rows = 14
    top = y
    for r in range(rows + 1):
        d.line([(x_cols[0], y + r * 34), (x_cols[-1], y + r * 34)], fill="black", width=2)
    for x in x_cols:
        d.line([(x, top), (x, top + rows * 34)], fill="black", width=2)
    for r in range(rows):
        d.text((x_cols[0] + 8, top + r * 34 + 5), rng.choice(["Ho Sam Teck", "Chan Chee Yan", "John", "Razaq", "Kenneth", "Amirul", "Wilson", "Clover", "Calvin", "Bernard", "Syahdan", "Fia"]), font=f, fill="black")
        d.text((x_cols[1] + 60, top + r * 34 + 5), str(rng.randint(1, 40)), font=f, fill="black")
        d.text((x_cols[2] + 30, top + r * 34 + 5), f"{rng.uniform(80, 400):.2f}", font=f, fill="black")
        d.text((x_cols[3] + 20, top + r * 34 + 5), f"{rng.randint(100, 4000):,}", font=f, fill="black")
    y = top + rows * 34 + 70
    d.text((120, y), "COEFFICIENT PERCENTAGE TABLE", font=fb, fill="black"); y += 50
    for block in range(2):
        top = y
        n = 8 if block == 0 else 6
        for r in range(n + 1):
            d.line([(120, top + r * 30), (1120, top + r * 30)], fill="black", width=1)
        for x in [120, 470, 620, 790, 960, 1120]:
            d.line([(x, top), (x, top + n * 30)], fill="black", width=1)
        for r in range(n):
            d.text((128, top + r * 30 + 4), f"{rng.randint(1, 9)},000,001 to {rng.randint(1, 9)},000,000", font=font(FONT, 19), fill="black")
            for x in [480, 640, 810, 980]:
                d.text((x, top + r * 30 + 4), f"{rng.uniform(0, 9):.3f}", font=font(FONT, 19), fill="black")
        y = top + n * 30 + 50
    top = y
    for r in range(10):
        d.line([(120, top + r * 30), (700, top + r * 30)], fill="black", width=1)
        d.text((128, top + r * 30 + 4), words(rng, 3).capitalize(), font=font(FONT, 19), fill="black")
        d.text((560, top + r * 30 + 4), money(rng), font=font(FONT, 19), fill="black")
    d.line([(120, top), (120, top + 9 * 30)], fill="black", width=1)
    d.line([(500, top), (500, top + 9 * 30)], fill="black", width=1)
    d.line([(700, top), (700, top + 9 * 30)], fill="black", width=1)
    d.text((120, H - 150), "SAMPLE AUDIT PARTNERS (AF 0000)", font=fb, fill="black")
    d.text((120, H - 115), "Chartered Accountants", font=f, fill="black")
    return img


def letter(rng):
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f = font(SERIF, 24)
    d.text((140, 120), words(rng, 3).upper(), font=font(BOLD, 34), fill="black")
    y = 220
    while y < H - 160:
        n = rng.randint(4, 9)
        for i in range(n):
            line = words(rng, 9 if i < n - 1 else rng.randint(3, 8))
            d.text((140, y), line.capitalize() if i == 0 else line, font=f, fill="black")
            y += 38
            if y > H - 160: break
        y += 30
    return img


def invoice(rng):
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f, fb = font(FONT, 21), font(BOLD, 21)
    d.text((110, 100), "TAX INVOICE", font=font(BOLD, 40), fill=(20, 40, 120))
    d.rectangle([880, 90, 1130, 200], outline=(200, 30, 30), width=4)
    d.text((900, 125), "PAID", font=font(BOLD, 44), fill=(200, 30, 30))
    y = 200
    for i in range(5):
        d.text((110, y), words(rng, 4).title(), font=f, fill="black"); y += 32
    y += 40
    d.line([(110, y), (1130, y)], fill="black", width=3); y += 10
    for lab, x in [("No", 120), ("Description", 200), ("Qty", 700), ("Unit price", 820), ("Amount", 1010)]:
        d.text((x, y), lab, font=fb, fill="black")
    y += 40
    d.line([(110, y), (1130, y)], fill="black", width=2)
    for r in range(18):
        y += 12
        d.text((120, y), str(r + 1), font=f, fill="black")
        d.text((200, y), words(rng, rng.randint(2, 5)), font=f, fill="black")
        d.text((710, y), str(rng.randint(1, 50)), font=f, fill="black")
        d.text((820, y), money(rng), font=f, fill="black")
        d.text((1010, y), money(rng), font=f, fill="black")
        y += 32
        d.line([(110, y), (1130, y)], fill=(150, 150, 150), width=1)
    y += 30
    for lab in ["Subtotal", "SST 8%", "Total"]:
        d.text((800, y), lab, font=fb, fill="black"); d.text((1010, y), money(rng), font=f, fill="black"); y += 36
    d.ellipse([200, H - 330, 420, H - 110], outline=(40, 60, 170), width=5)
    d.text((240, H - 240), "APPROVED", font=font(BOLD, 28), fill=(40, 60, 170))
    return img


def statement(rng):
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f = font(FONT, 19)
    d.text((100, 90), "BANK STATEMENT", font=font(BOLD, 34), fill="black")
    d.text((100, 140), "Account " + "".join(str(rng.randint(0, 9)) for _ in range(12)), font=f, fill="black")
    y = 220
    d.rectangle([90, y, 1150, y + 40], fill=(225, 225, 225))
    for lab, x in [("Date", 100), ("Description", 230), ("Debit", 760), ("Credit", 900), ("Balance", 1040)]:
        d.text((x, y + 9), lab, font=font(BOLD, 19), fill="black")
    y += 52
    r = 0
    while y < H - 120:
        if r % 2: d.rectangle([90, y - 4, 1150, y + 30], fill=(242, 242, 242))
        d.text((100, y), f"{rng.randint(1, 28):02d}/0{rng.randint(1, 9)}", font=f, fill="black")
        d.text((230, y), words(rng, rng.randint(2, 6)).upper(), font=f, fill="black")
        d.text((760 if rng.random() < .5 else 900, y), money(rng), font=f, fill="black")
        d.text((1040, y), money(rng), font=f, fill="black")
        y += 36; r += 1
    return img


def guide(rng):
    """Like the guideline pages John scans: four framed boxes, dark header blocks, small icons, small print."""
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f = font(SERIF, 15)
    boxes = [(95, 150, 600, 860), (640, 150, 1145, 860), (95, 905, 600, 1640), (640, 905, 1145, 1640)]
    for k, (x0, y0, x1, y1) in enumerate(boxes):
        d.rectangle([x0, y0, x1, y1], outline="black", width=3)
        y = y0 + 25
        d.text((x0 + 20, y), words(rng, 3).title(), font=font(BOLD, 20), fill="black"); y += 40
        dark = (k % 3 == 1) or (k == 2 and rng.random() < 0.7)
        if dark:
            bx0, by0 = x1 - 210, y0 + 90
            d.rectangle([bx0, by0, x1 - 25, by0 + 330], fill=(40, 42, 45))
            for j in range(6): d.text((bx0 + 12, by0 + 20 + j * 45), words(rng, 2), font=f, fill="white")
        icons = k == 1 and rng.random() < 0.6
        while y < y1 - 30:
            xr = (x1 - 230) if dark and y < y0 + 440 else (x1 - 30)
            if icons and y < y1 - 120 and rng.random() < 0.15:
                cx = x0 + 60 + rng.random() * 120
                d.ellipse([cx, y, cx + 50, y + 50], outline="black", width=3); d.rectangle([cx + 70, y + 5, cx + 140, y + 45], outline="black", width=2)
                y += 70; continue
            n = max(2, int((xr - x0 - 40) / 70))
            d.text((x0 + 20, y), words(rng, n), font=f, fill="black")
            y += 24
    return img


KINDS = {"workpaper": workpaper, "letter": letter, "invoice": invoice, "statement": statement, "guide": guide}


def make(kind, seed):
    return np.array(KINDS[kind](random.Random(seed)))


if __name__ == "__main__":
    for k in KINDS:
        Image.fromarray(make(k, 1)).save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "videos", f"doc_{k}.png"))
    print("ok")
