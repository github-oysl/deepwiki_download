"""生成扩展图标（纯标准库实现的 PNG 编码 + 超采样抗锯齿绘制）。

图形：靛蓝圆角方块 + 白色文档线条 + 下载箭头 = “把文档导出下来”。
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
SS = 4  # 超采样倍数


def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return math.hypot(ax, ay) + min(max(dx, dy), 0.0) - r


def in_tri(p, a, b, c):
    def cross(o, p1, p2):
        return (p1[0] - o[0]) * (p2[1] - o[1]) - (p2[0] - o[0]) * (p1[1] - o[1])
    d1 = cross(a, b, p)
    d2 = cross(b, c, p)
    d3 = cross(c, a, p)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


# 前景形状（归一化坐标 0..1）
BARS = [
    (0.500, 0.240, 0.230, 0.040, 0.040),   # 第一行：宽
    (0.435, 0.375, 0.165, 0.040, 0.040),   # 第二行：稍短
    (0.500, 0.515, 0.040, 0.085, 0.040),   # 箭头竖杆
]
TRI = ((0.335, 0.615), (0.665, 0.615), (0.500, 0.815))
BASE = (0.500, 0.880, 0.200, 0.038, 0.038)  # 底部横线


def fg_inside(u, v):
    for cx, cy, hw, hh, r in BARS:
        if sd_round_rect(u, v, cx, cy, hw, hh, r) <= 0:
            return True
    cx, cy, hw, hh, r = BASE
    if sd_round_rect(u, v, cx, cy, hw, hh, r) <= 0:
        return True
    return in_tri((u, v), *TRI)


def sample(u, v):
    if sd_round_rect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) > 0:
        return (0, 0, 0, 0)
    if fg_inside(u, v):
        return (255, 255, 255, 255)
    t = max(0.0, min(1.0, (u * 0.45 + v * 0.55)))
    r = int(0x6E + (0x3A - 0x6E) * t)
    g = int(0x69 + (0x30 - 0x69) * t)
    b = int(0xF6 + (0xC0 - 0xF6) * t)
    return (r, g, b, 255)


def render(size):
    buf = bytearray()
    n = SS * SS
    for y in range(size):
        row = bytearray()
        for x in range(size):
            ar = ag = ab = aa = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size
                    r, g, b, a = sample(u, v)
                    k = a / 255.0
                    ar += r * k
                    ag += g * k
                    ab += b * k
                    aa += a
            cov = aa / (255.0 * n)
            if cov <= 0.001:
                row += b'\x00\x00\x00\x00'
            else:
                row += bytes((
                    int(round(ar / n / max(cov, 1e-6))),
                    int(round(ag / n / max(cov, 1e-6))),
                    int(round(ab / n / max(cov, 1e-6))),
                    int(round(cov * 255)),
                ))
        buf += row
    return bytes(buf)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        data = render(size)
        path = os.path.join(OUT_DIR, 'icon%d.png' % size)
        write_png(path, size, size, data)
        print('wrote', path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    main()
