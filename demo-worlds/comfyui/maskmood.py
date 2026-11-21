"""Mood variant by inpainting a fixed mask region (for faces the face detector misses). Z-Image.
Usage: python3 -I maskmood.py <jobs.json> <outdir>"""
import json, sys, time, urllib.parse
sys.path.insert(0, sys.path[0] if sys.path[0] else ".")
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from moods_lib import call, upload

jobs_path, outdir = sys.argv[1:3]
for job in json.load(open(jobs_path)):
    img, mask = upload(job["source"]), upload(job["mask"])
    n = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "dd": {"class_type": "DifferentialDiffusion", "inputs": {"model": ["unet", 0]}},
        "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["dd", 0], "shift": 3.0}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "Flux/ae.safetensors"}},
        "load": {"class_type": "LoadImage", "inputs": {"image": img}},
        "mload": {"class_type": "LoadImage", "inputs": {"image": mask}},
        "mask": {"class_type": "ImageToMask", "inputs": {"image": ["mload", 0], "channel": "red"}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["load", 0], "vae": ["vae", 0]}},
        "lm": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["enc", 0], "mask": ["mask", 0]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": job["prompt"], "clip": ["clip", 0]}},
        "neg": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}},
        "sample": {"class_type": "KSampler", "inputs": {"model": ["shift", 0], "positive": ["pos", 0], "negative": ["neg", 0],
                   "latent_image": ["lm", 0], "seed": job.get("seed", 11), "steps": 9, "cfg": 1.0,
                   "sampler_name": "res_multistep", "scheduler": "simple", "denoise": job.get("denoise", 0.8)}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]}},
        "comp": {"class_type": "ImageCompositeMasked", "inputs": {"destination": ["load", 0], "source": ["dec", 0], "x": 0, "y": 0, "resize_source": False, "mask": ["mask", 0]}},
        "rembg": {"class_type": "InspyrenetRembg", "inputs": {"image": ["comp", 0], "torchscript_jit": "default"}},
        "save_raw": {"class_type": "SaveImage", "inputs": {"images": ["comp", 0], "filename_prefix": "teahouse/" + job["name"] + "-raw"}},
        "save_cut": {"class_type": "SaveImage", "inputs": {"images": ["rembg", 0], "filename_prefix": "teahouse/" + job["name"]}},
    }
    pid = json.loads(call("/prompt", json.dumps({"prompt": n}).encode(), {"Content-Type": "application/json"}))["prompt_id"]
    while True:
        h = json.loads(call(f"/history/{pid}"))
        if pid in h: break
        time.sleep(1)
    e = h[pid]
    if e.get("status", {}).get("status_str") == "error":
        print("ERROR", job["name"], json.dumps(e["status"]["messages"][-1])[:800]); continue
    for nid, suf in (("save_raw", "-raw"), ("save_cut", "")):
        i = e["outputs"][nid]["images"][0]
        q = urllib.parse.urlencode({"filename": i["filename"], "subfolder": i["subfolder"], "type": i["type"]})
        open(f"{outdir}/{job['name']}{suf}.png", "wb").write(call("/view?" + q))
    print(job["name"], "ok", flush=True)
