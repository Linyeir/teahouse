# Sources of the sample worlds

The sample worlds that the server offers live in `packages/server/samples/`, one world folder
each. This folder holds what they were made from:

- `image-prompts.md`: the prompts for the character and background images.
- `comfyui/`: the scripts that generated the images with a local ComfyUI (Z-Image Turbo and an
  Illustrious checkpoint), changed the faces per mood (FaceDetailer, or a fixed mask for the
  animals) and cut the sprites out (InspyrenetRembg).
