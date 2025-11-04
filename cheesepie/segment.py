import os
import sys
import argparse
from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np
from PIL import Image
from skimage.measure import label
from skimage.morphology import remove_small_objects, dilation, square
from skimage.segmentation import find_boundaries


@dataclass
class Options:
    height: int = 120
    width: int = 160
    noiseThresh: int = 10
    maxNumObjects: int = 20
    minNumPixels: int = 25
    outline_color: Tuple[int, int, int] = (255, 255, 255)  # white by default
    outline_thickness: int = 3
    outline_pattern: str = "solid"  # "solid" or "striped"
    outline_alpha: float = 0.8  # transparency of overlay (0=transparent, 1=opaque)


def simple_segment(
    frame: Image.Image,
    bkg: Image.Image,
    opt: Optional[Options] = None,
):
    """
    Segment moving objects by thresholding the luminance of (frame - background).
    Returns:
        labels_img: uint8 label image
        overlay_img: original-size frame with blob outlines
    """
    opt = opt or Options()
    orig_size = frame.size

    # Resize for segmentation
    frame_small = frame.resize((opt.width, opt.height), Image.BICUBIC)
    bkg_small = bkg.resize((opt.width, opt.height), Image.BICUBIC)

    frame_rgb = np.array(frame_small.convert("RGB"), dtype=np.uint8)
    framed = frame_rgb.astype(np.float64)
    bkgd = np.array(bkg_small.convert("RGB"), dtype=np.float64)

    lum = np.max(framed - bkgd, axis=2)
    meanBkg, stdBkg = float(np.mean(lum)), float(np.std(lum))
    if stdBkg == 0 or not np.isfinite(stdBkg):
        return Image.fromarray(np.zeros(lum.shape, dtype=np.uint8)), frame.copy()

    # Binary search threshold
    lower, upper = 1, int(opt.noiseThresh)
    prev_thresh = (upper + lower) // 2
    for _ in range(32):
        if lower > upper:
            break
        thresh = (upper + lower) // 2
        bw = lum > (meanBkg + thresh * stdBkg)
        labeled = label(bw, connectivity=2)
        num_objects = int(labeled.max())
        if num_objects < opt.maxNumObjects:
            upper = thresh - 1
            prev_thresh = thresh
        else:
            lower = thresh + 1

    thresh = prev_thresh
    bw = lum > (meanBkg + thresh * stdBkg)
    labeled = label(bw, connectivity=2)
    filtered = remove_small_objects(labeled, min_size=int(opt.minNumPixels))

    # Boundary mask
    boundaries = find_boundaries(filtered, connectivity=2, mode="outer")
    if opt.outline_thickness > 1:
        boundaries = dilation(boundaries, square(opt.outline_thickness))

    # Apply stripe pattern
    if opt.outline_pattern == "striped":
        pattern = (np.indices(boundaries.shape).sum(axis=0) % 4 == 0)
        boundaries = boundaries & pattern

    # Overlay outlines
    overlay_small = frame_rgb.copy()
    overlay_small[boundaries] = opt.outline_color

    # Upscale overlay and blend onto original
    overlay_large = Image.fromarray(overlay_small).resize(orig_size, Image.BICUBIC)
    overlay_final = Image.blend(frame.convert("RGB"), overlay_large, alpha=opt.outline_alpha)

    labels_uint8 = np.clip(filtered, 0, 255).astype(np.uint8)
    return Image.fromarray(labels_uint8), overlay_final


def parse_args():
    p = argparse.ArgumentParser(description="Simple segmentation with configurable outline color and pattern.")
    p.add_argument("frame")
    p.add_argument("background")
    p.add_argument("output")
    p.add_argument("--overlay", help="Path to save overlay image (optional)")
    p.add_argument("--height", type=int, default=120)
    p.add_argument("--width", type=int, default=160)
    p.add_argument("--noiseThresh", type=int, default=10)
    p.add_argument("--maxNumObjects", type=int, default=20)
    p.add_argument("--minNumPixels", type=int, default=25)
    p.add_argument("--outlineColor", type=str, default="255,255,255", help="R,G,B (default white)")
    p.add_argument("--outlineThickness", type=int, default=1)
    p.add_argument("--outlinePattern", type=str, default="solid", choices=["solid", "striped"])
    p.add_argument("--outlineAlpha", type=float, default=0.8, help="Transparency of overlay (0–1, default 0.8)")
    return p.parse_args()


def main():
    args = parse_args()
    if not os.path.exists(args.frame) or not os.path.exists(args.background):
        print("Error: input files not found.")
        sys.exit(1)

    try:
        outline_rgb = tuple(int(c) for c in args.outlineColor.split(","))
        if len(outline_rgb) != 3 or any(c < 0 or c > 255 for c in outline_rgb):
            raise ValueError
    except Exception:
        print("Error: --outlineColor must be 'R,G,B' with 0–255 values")
        sys.exit(1)

    opt = Options(
        height=args.height,
        width=args.width,
        noiseThresh=args.noiseThresh,
        maxNumObjects=args.maxNumObjects,
        minNumPixels=args.minNumPixels,
        outline_color=outline_rgb,
        outline_thickness=args.outlineThickness,
        outline_pattern=args.outlinePattern,
        outline_alpha=args.outlineAlpha,
    )

    frame = Image.open(args.frame)
    bkg = Image.open(args.background)
    labels_img, overlay_img = simple_segment(frame, bkg, opt=opt)
    labels_img.save(args.output)
    if args.overlay:
        overlay_img.save(args.overlay)
    print(f"Saved labels to '{args.output}'" + (f" and overlay to '{args.overlay}'" if args.overlay else ""))


if __name__ == "__main__":
    main()
