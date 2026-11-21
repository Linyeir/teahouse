"""Generate demo-world images through the ComfyUI API.

Usage: python3 -I gen.py <jobs.json> <outdir> [--host http://127.0.0.1:7821]
Each job: {"name", "engine": "illustrious"|"zimage", "kind": "sprite"|"bg",
           "prompt", "negative"?, "seed"?}
Sprites are also saved cut out (InspyrenetRembg) as <name>.png; the raw one as <name>-raw.png.
"""
import json
import sys
import time
import urllib.parse
import urllib.request

args = sys.argv[1:]
HOST = "http://127.0.0.1:7821"
if "--host" in args:
    i = args.index("--host")
    HOST = args[i + 1]
    del args[i : i + 2]
jobs_path, outdir = args

SIZES = {"sprite": (832, 1216), "bg": (1344, 768)}
DEFAULT_NEG = "nsfw, nude, lowres, bad anatomy, bad hands, extra fingers, text, watermark, signature, logo, multiple views, cropped head"


def model_nodes(job):
    """Return (nodes, model_ref, clip_ref, vae_ref, sampler settings)."""
    if job["engine"] == "illustrious":
        nodes = {"ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "waiIllustriousSDXL_v170.safetensors"}}}
        return nodes, ["ckpt", 0], ["ckpt", 1], ["ckpt", 2], dict(steps=28, cfg=6.0, sampler_name="euler_ancestral", scheduler="normal"), False
    nodes = {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": 3.0}},
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "Flux/ae.safetensors"}},
    }
    return nodes, ["shift", 0], ["clip", 0], ["vae", 0], dict(steps=9, cfg=1.0, sampler_name="res_multistep", scheduler="simple"), True


def workflow(job):
    nodes, model, clip, vae, sampler, zero_neg = model_nodes(job)
    w, h = SIZES[job["kind"]]
    nodes["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"text": job["prompt"], "clip": clip}}
    if zero_neg:
        nodes["neg"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}}
        nodes["latent"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}}
    else:
        nodes["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": job.get("negative", DEFAULT_NEG), "clip": clip}}
        nodes["latent"] = {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}}
    nodes["sample"] = {"class_type": "KSampler", "inputs": {
        "model": model, "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0],
        "seed": job.get("seed", 1234), "denoise": 1.0, **sampler}}
    nodes["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": vae}}
    raw_name = job["name"] + ("-raw" if job["kind"] == "sprite" else "")
    nodes["save_raw"] = {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": "teahouse/" + raw_name}}
    if job["kind"] == "sprite":
        nodes["rembg"] = {"class_type": "InspyrenetRembg", "inputs": {"image": ["decode", 0], "torchscript_jit": "default"}}
        nodes["save_cut"] = {"class_type": "SaveImage", "inputs": {"images": ["rembg", 0], "filename_prefix": "teahouse/" + job["name"]}}
    return nodes


def call(path, data=None):
    req = urllib.request.Request(HOST + path, data=json.dumps(data).encode() if data else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def run(job):
    pid = json.loads(call("/prompt", {"prompt": workflow(job)}))["prompt_id"]
    while True:
        hist = json.loads(call(f"/history/{pid}"))
        if pid in hist:
            entry = hist[pid]
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(json.dumps(entry["status"])[:1500])
            break
        time.sleep(1)
    for node_id, out in entry["outputs"].items():
        for img in out.get("images", []):
            base = job["name"] + ("-raw" if node_id == "save_raw" and job["kind"] == "sprite" else "")
            q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
            with open(f"{outdir}/{base}.png", "wb") as f:
                f.write(call("/view?" + q))
            print("saved", f"{outdir}/{base}.png", flush=True)


for job in json.load(open(jobs_path)):
    t = time.time()
    run(job)
    print(f"  {job['name']}: {time.time() - t:.0f}s", flush=True)
