# OpenCLIP golden fixtures

These fixtures use deterministic synthetic gradients and stripes only; no dataset images are included. `stripes_square_rgba.png` is saved as RGBA and converted to RGB before preprocessing. The output features use ViT-B-16/openai on CPU in fp32.

- open_clip_torch: `3.3.0`
- torch: `2.8.0+cu128`
- model_reid interpolation: `bicubic`
- Captions: ['a woman in a red coat carrying a black bag', 'a man wearing a white shirt and blue jeans', 'person with a yellow backpack']
- Generator command: `/mnt/data/lab_clip/.venv/bin/python scripts/labclip_golden.py --labclip /mnt/data/lab_clip --out service/tests/fixtures/openclip_golden`
