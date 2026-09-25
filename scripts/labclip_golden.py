"""Generate small synthetic golden fixtures from lab_clip and open_clip."""

from __future__ import annotations

import argparse
import importlib.metadata
import sys
from pathlib import Path

import numpy as np
from PIL import Image

CAPTIONS = [
    "a woman in a red coat carrying a black bag",
    "a man wearing a white shirt and blue jeans",
    "person with a yellow backpack",
]
IMAGE_SIZE = (384, 128)


def _synthetic_images() -> dict[str, Image.Image]:
    images: dict[str, Image.Image] = {}

    width, height = 64, 160
    x = np.arange(width, dtype=np.int32)[None, :]
    y = np.arange(height, dtype=np.int32)[:, None]
    gradient = np.stack(
        [
            np.broadcast_to(x * 255 // (width - 1), (height, width)),
            np.broadcast_to(y * 255 // (height - 1), (height, width)),
            np.broadcast_to((x * 7 + y * 3) % 256, (height, width)),
        ],
        axis=-1,
    ).astype(np.uint8)
    images["gradient_64x160"] = Image.fromarray(gradient)

    width, height = 128, 384
    x = np.arange(width, dtype=np.int32)[None, :]
    y = np.arange(height, dtype=np.int32)[:, None]
    stripe_ids = (x // 16 + y // 48) % 4
    palette = np.array(
        [[220, 35, 45], [35, 170, 90], [35, 75, 220], [235, 190, 35]],
        dtype=np.uint8,
    )
    stripes = palette[stripe_ids]
    images["stripes_128x384"] = Image.fromarray(stripes)

    width, height = 97, 211
    x = np.arange(width, dtype=np.int32)[None, :]
    y = np.arange(height, dtype=np.int32)[:, None]
    odd_gradient = np.stack(
        [
            np.broadcast_to(
                (x * 171 // (width - 1) + y * 84 // (height - 1)) % 256, (height, width)
            ),
            np.broadcast_to(
                (x * 39 // (width - 1) + y * 216 // (height - 1)) % 256, (height, width)
            ),
            np.broadcast_to(
                (x * 125 // (width - 1) + y * 131 // (height - 1)) % 256, (height, width)
            ),
        ],
        axis=-1,
    ).astype(np.uint8)
    images["gradient_97x211"] = Image.fromarray(odd_gradient)

    width = height = 300
    x = np.arange(width, dtype=np.int32)[None, :]
    y = np.arange(height, dtype=np.int32)[:, None]
    tile_ids = (x // 25 + (y // 50) * 2) % 5
    rgba_palette = np.array(
        [[45, 60, 90], [180, 55, 60], [45, 145, 115], [220, 175, 65], [125, 80, 165]],
        dtype=np.uint8,
    )
    rgb = rgba_palette[tile_ids]
    alpha = np.broadcast_to(64 + x * 191 // (width - 1), (height, width)).astype(np.uint8)
    rgba = np.concatenate([rgb, alpha[..., None]], axis=-1)
    images["stripes_square_rgba"] = Image.fromarray(rgba)

    return images


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labclip", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    sys.path.insert(0, str(args.labclip.resolve() / "src"))

    import open_clip
    import torch
    from clip_model import create_reid_model_and_transforms
    from clip_transforms import build_reid_transforms

    args.out.mkdir(parents=True, exist_ok=True)
    images_dir = args.out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    images = _synthetic_images()
    for name, image in images.items():
        image.save(images_dir / f"{name}.png", format="PNG")

    model, _, preprocess_val, tokenizer = create_reid_model_and_transforms(
        model_name="ViT-B-16",
        pretrained="openai",
        device=torch.device("cpu"),
        img_height=IMAGE_SIZE[0],
        img_width=IMAGE_SIZE[1],
    )
    model = model.to(device="cpu", dtype=torch.float32).eval()

    preprocess_cfg = open_clip.get_model_preprocess_cfg(model)
    model_reid_mean = np.asarray(preprocess_cfg["mean"], dtype=np.float32)
    model_reid_std = np.asarray(preprocess_cfg["std"], dtype=np.float32)
    model_reid_interpolation = str(preprocess_cfg["interpolation"])
    model_reid_transform = build_reid_transforms(
        img_height=IMAGE_SIZE[0],
        img_width=IMAGE_SIZE[1],
        aug=False,
        is_train=False,
        mean=tuple(float(value) for value in model_reid_mean),
        std=tuple(float(value) for value in model_reid_std),
        interpolation=model_reid_interpolation,
    )

    preprocess_values: dict[str, np.ndarray] = {
        "model_reid_mean": model_reid_mean,
        "model_reid_std": model_reid_std,
        "model_reid_interpolation": np.asarray(model_reid_interpolation),
    }
    for name, image in images.items():
        rgb = image.convert("RGB")
        preprocess_values[f"reid_{name}"] = np.asarray(preprocess_val(rgb), dtype=np.float32)
        preprocess_values[f"model_reid_{name}"] = np.asarray(
            model_reid_transform(rgb), dtype=np.float32
        )
    np.savez_compressed(args.out / "preprocess.npz", **preprocess_values)

    image_batch = torch.stack(
        [preprocess_val(image.convert("RGB")) for image in images.values()]
    ).to(device="cpu", dtype=torch.float32)
    tokens = tokenizer(CAPTIONS).to(device="cpu")
    with torch.inference_mode():
        image_features = torch.nn.functional.normalize(
            model.encode_image(image_batch).float(), dim=-1
        )
        text_features = torch.nn.functional.normalize(model.encode_text(tokens).float(), dim=-1)
    np.savez_compressed(
        args.out / "embeddings.npz",
        image=image_features.cpu().numpy().astype(np.float32, copy=False),
        text=text_features.cpu().numpy().astype(np.float32, copy=False),
    )

    open_clip_version = importlib.metadata.version("open_clip_torch")
    torch_version = torch.__version__
    command = (
        "/mnt/data/lab_clip/.venv/bin/python scripts/labclip_golden.py "
        "--labclip /mnt/data/lab_clip --out service/tests/fixtures/openclip_golden"
    )
    (args.out / "README.md").write_text(
        "# OpenCLIP golden fixtures\n\n"
        "These fixtures use deterministic synthetic gradients and stripes only; no dataset "
        "images are included. `stripes_square_rgba.png` is saved as RGBA and converted to RGB "
        "before preprocessing. The output features use ViT-B-16/openai on CPU in fp32.\n\n"
        f"- open_clip_torch: `{open_clip_version}`\n"
        f"- torch: `{torch_version}`\n"
        f"- model_reid interpolation: `{model_reid_interpolation}`\n"
        f"- Captions: {CAPTIONS!r}\n"
        f"- Generator command: `{command}`\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
