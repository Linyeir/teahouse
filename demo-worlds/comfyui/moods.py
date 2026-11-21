"""Make mood variants of a sprite by repainting only the face (FaceDetailer), then cut out.

Usage: python3 -I moods.py <jobs.json> <outdir>
Job: {"name", "engine", "source": path to the raw neutral PNG, "prompt", "seed"?, "denoise"?}
"""
import json
import sys
import time
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, sys.path[0])
HOST = "http://127.0.0.1:7821"
jobs_path, outdir = sys.argv[1:3]
NEG = "nsfw, lowres, bad anatomy, text, watermark, closed eyes"


def call(path, data=None, headers=None):
    req = urllib.request.Request(HOST + path, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def upload(path):
    boundary = uuid.uuid4().hex
    name = path.rsplit("/", 1)[-1]
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            "Content-Type: image/png\r\n\r\n").encode() + open(path, "rb").read() + \
           f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    res = json.loads(call("/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}))
    return res["name"]


def workflow(job, image_name):
    if job["engine"] == "illustrious":
        n = {"ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "waiIllustriousSDXL_v170.safetensors"}}}
        model, clip, vae = ["ckpt", 0], ["ckpt", 1], ["ckpt", 2]
        n["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": clip}}
        s = dict(steps=28, cfg=6.0, sampler_name="euler_ancestral", scheduler="normal")
    else:
        n = {
            "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
            "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["unet", 0], "shift": 3.0}},
            "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"}},
            "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "Flux/ae.safetensors"}},
        }
        model, clip, vae = ["shift", 0], ["clip", 0], ["vae", 0]
        n["neg"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}}
        s = dict(steps=9, cfg=1.0, sampler_name="res_multistep", scheduler="simple")
    n["load"] = {"class_type": "LoadImage", "inputs": {"image": image_name}}
    n["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"text": job["prompt"], "clip": clip}}
    n["det"] = ({"class_type": "CLIPSegDetectorProvider", "inputs": {"text": job["clipseg"], "blur": 7.0, "threshold": 0.4, "dilation_factor": 4}}
                if job.get("clipseg") else {"class_type": "UltralyticsDetectorProvider", "inputs": {"model_name": "bbox/face_yolov8m.pt"}})
    n["face"] = {"class_type": "FaceDetailer", "inputs": {
        "image": ["load", 0], "model": model, "clip": clip, "vae": vae, "positive": ["pos", 0], "negative": ["neg", 0],
        "bbox_detector": ["det", 0], "guide_size": 512, "guide_size_for": True, "max_size": 1024,
        "seed": job.get("seed", 7), **s, "denoise": job.get("denoise", 0.6), "feather": 8, "noise_mask": True,
        "force_inpaint": True, "bbox_threshold": job.get("bbox_threshold", 0.3), "bbox_dilation": 20, "bbox_crop_factor": 2.5,
        "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0,
        "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10, "wildcard": "", "cycle": 1}}
    n["rembg"] = {"class_type": "InspyrenetRembg", "inputs": {"image": ["face", 0], "torchscript_jit": "default"}}
    n["save_raw"] = {"class_type": "SaveImage", "inputs": {"images": ["face", 0], "filename_prefix": "teahouse/" + job["name"] + "-raw"}}
    n["save_cut"] = {"class_type": "SaveImage", "inputs": {"images": ["rembg", 0], "filename_prefix": "teahouse/" + job["name"]}}
    return n


for job in json.load(open(jobs_path)):
    t = time.time()
    pid = json.loads(call("/prompt", json.dumps({"prompt": workflow(job, upload(job["source"]))}).encode(),
                          {"Content-Type": "application/json"}))["prompt_id"]
    while True:
        hist = json.loads(call(f"/history/{pid}"))
        if pid in hist:
            break
        time.sleep(1)
    entry = hist[pid]
    if entry.get("status", {}).get("status_str") == "error":
        print("ERROR", job["name"], json.dumps(entry["status"])[:1500])
        continue
    for node_id in ("save_raw", "save_cut"):
        img = entry["outputs"][node_id]["images"][0]
        q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img["subfolder"], "type": img["type"]})
        suffix = "-raw" if node_id == "save_raw" else ""
        open(f"{outdir}/{job['name']}{suffix}.png", "wb").write(call("/view?" + q))
    print(f"{job['name']}: {time.time() - t:.0f}s", flush=True)
