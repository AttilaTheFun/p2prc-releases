// swift_gpu's WebGPU executor: implements the Swift `GPUWebHost` protocol
// over navigator.gpu. This file is the ONLY place in the ecosystem that
// touches the WebGPU API — Swift encodes SwiftGPU commands across the
// swift_ffi bridge as packed Float32 bytes; this executes them.
//
// Usage (before starting the consumer app):
//   const gpuHost = await createSwiftGPUHost(canvas);
//   bridge.gpuConnect(gpuHost);

const TEXTURED_SHADER = /* wgsl */ `
struct Uniforms {
  transform: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@location(0) pos: vec2f, @location(1) uv: vec2f) -> VSOut {
  var out: VSOut;
  out.position = u.transform * vec4f(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}
`;

const RECT_SHADER = /* wgsl */ `
struct Uniforms {
  transform: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) halfSize: vec2f,
  @location(2) radiusBorder: vec2f,
  @location(3) color: vec4f,
};

@vertex
fn vs(
  @location(0) pos: vec2f,
  @location(1) local: vec2f,
  @location(2) halfSize: vec2f,
  @location(3) radiusBorder: vec2f,
  @location(4) color: vec4f,
) -> VSOut {
  var out: VSOut;
  out.position = u.transform * vec4f(pos, 0.0, 1.0);
  out.local = local;
  out.halfSize = halfSize;
  out.radiusBorder = radiusBorder;
  out.color = color;
  return out;
}

fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let r = min(in.radiusBorder.x, min(in.halfSize.x, in.halfSize.y));
  let d = sdRoundBox(in.local, in.halfSize, r);
  var alpha: f32;
  if (in.radiusBorder.y > 0.0) {
    alpha = 1.0 - smoothstep(-0.75, 0.75, abs(d) - in.radiusBorder.y * 0.5);
  } else {
    alpha = 1.0 - smoothstep(-0.75, 0.75, d);
  }
  return vec4f(in.color.rgb, in.color.a * alpha);
}
`;

const COLOR_SHADER = /* wgsl */ `
struct Uniforms {
  transform: mat4x4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs(@location(0) pos: vec2f, @location(1) color: vec4f) -> VSOut {
  var out: VSOut;
  out.position = u.transform * vec4f(pos, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return in.color;
}
`;

export async function createSwiftGPUHost(canvas) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU unavailable");
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  const context = canvas.getContext("webgpu");
  context.configure({ device, format, alphaMode: "opaque" });

  // One explicit uniform layout shared by both pipelines, so one uniform
  // bind group per transform serves whichever pipeline draws under it.
  const uniformLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }],
  });
  const textureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });

  const texturedModule = device.createShaderModule({ code: TEXTURED_SHADER });
  const texturedPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout, textureLayout] }),
    vertex: {
      module: texturedModule,
      entryPoint: "vs",
      buffers: [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 8, format: "float32x2" },
        ],
      }],
    },
    fragment: {
      module: texturedModule,
      entryPoint: "fs",
      targets: [{
        format,
        // Premultiplied alpha (opaque content unaffected).
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });

  const colorModule = device.createShaderModule({ code: COLOR_SHADER });
  const colorPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout] }),
    vertex: {
      module: colorModule,
      entryPoint: "vs",
      buffers: [{
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 8, format: "float32x4" },
        ],
      }],
    },
    fragment: {
      module: colorModule,
      entryPoint: "fs",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });

  const rectModule = device.createShaderModule({ code: RECT_SHADER });
  const rectPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [uniformLayout] }),
    vertex: {
      module: rectModule,
      entryPoint: "vs",
      buffers: [{
        arrayStride: 48,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" },
          { shaderLocation: 1, offset: 8, format: "float32x2" },
          { shaderLocation: 2, offset: 16, format: "float32x2" },
          { shaderLocation: 3, offset: 24, format: "float32x2" },
          { shaderLocation: 4, offset: 32, format: "float32x4" },
        ],
      }],
    },
    fragment: {
      module: rectModule,
      entryPoint: "fs",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const textures = new Map(); // id -> { texture, bindGroup }

  // A pool of uniform (matrix) buffers + bind groups, one per transform
  // change per frame, reused across frames.
  const uniformPool = [];
  function uniformSlot(index) {
    if (!uniformPool[index]) {
      const buffer = device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      uniformPool[index] = {
        buffer,
        bindGroup: device.createBindGroup({
          layout: uniformLayout,
          entries: [{ binding: 0, resource: { buffer } }],
        }),
      };
    }
    return uniformPool[index];
  }

  // Frame state: commands accumulate between gpuBeginFrame/gpuEndFrame and
  // execute in one render pass at the end.
  let clearValue = { r: 0, g: 0, b: 0, a: 1 };
  let commands = [];

  function floats(bytes) {
    // Copy: the wasm-backed array's memory is only valid during the call.
    return new Float32Array(new Uint8Array(bytes).buffer, 0, bytes.length / 4);
  }

  function vertexBuffer(data) {
    const buffer = device.createBuffer({
      size: (data.byteLength + 3) & ~3,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(data);
    buffer.unmap();
    return buffer;
  }

  return {
    gpuCreateTexture(id, width, height, rgba) {
      const texture = device.createTexture({
        size: [width, height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture },
        new Uint8Array(rgba),
        { bytesPerRow: width * 4 },
        [width, height],
      );
      const bindGroup = device.createBindGroup({
        layout: textureLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: texture.createView() },
        ],
      });
      textures.set(id, { texture, bindGroup });
    },

    gpuDestroyTexture(id) {
      const entry = textures.get(id);
      if (entry) {
        entry.texture.destroy();
        textures.delete(id);
      }
    },

    gpuBeginFrame(red, green, blue, alpha) {
      clearValue = { r: red, g: green, b: blue, a: alpha };
      commands = [];
    },

    gpuSetTransform(matrixBytes) {
      commands.push({ kind: "transform", matrix: floats(matrixBytes).slice() });
    },

    gpuDrawTextured(id, vertexBytes) {
      commands.push({ kind: "textured", id, vertices: floats(vertexBytes).slice() });
    },

    gpuDrawColor(vertexBytes) {
      commands.push({ kind: "color", vertices: floats(vertexBytes).slice() });
    },

    gpuDrawRects(vertexBytes) {
      commands.push({ kind: "rects", vertices: floats(vertexBytes).slice() });
    },

    gpuSetScissor(x, y, width, height) {
      commands.push({ kind: "scissor", x, y, width, height });
    },

    gpuClearScissor() {
      commands.push({ kind: "scissor", x: 0, y: 0, width: -1, height: -1 });
    },

    gpuEndFrame() {
      // Stage per-transform uniforms (queue writes land before the submit).
      let slotIndex = -1;
      for (const command of commands) {
        if (command.kind === "transform") {
          slotIndex += 1;
          device.queue.writeBuffer(uniformSlot(slotIndex).buffer, 0, command.matrix);
          command.slot = slotIndex;
        }
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue,
        }],
      });
      const frameBuffers = [];
      let currentSlot = null;
      for (const command of commands) {
        if (command.kind === "transform") {
          currentSlot = uniformSlot(command.slot);
          continue;
        }
        if (command.kind === "scissor") {
          if (command.width < 0) {
            pass.setScissorRect(0, 0, canvas.width, canvas.height);
          } else {
            const x = Math.max(0, Math.min(command.x, canvas.width));
            const y = Math.max(0, Math.min(command.y, canvas.height));
            pass.setScissorRect(
              x, y,
              Math.max(0, Math.min(command.width, canvas.width - x)),
              Math.max(0, Math.min(command.height, canvas.height - y)),
            );
          }
          continue;
        }
        if (!currentSlot) continue; // no transform set yet
        if (command.kind === "rects") {
          const buffer = vertexBuffer(command.vertices);
          frameBuffers.push(buffer);
          pass.setPipeline(rectPipeline);
          pass.setBindGroup(0, currentSlot.bindGroup);
          pass.setVertexBuffer(0, buffer);
          pass.draw(command.vertices.length / 12);
          continue;
        }
        if (command.kind === "textured") {
          const entry = textures.get(command.id);
          if (!entry) continue;
          const buffer = vertexBuffer(command.vertices);
          frameBuffers.push(buffer);
          pass.setPipeline(texturedPipeline);
          pass.setBindGroup(0, currentSlot.bindGroup);
          pass.setBindGroup(1, entry.bindGroup);
          pass.setVertexBuffer(0, buffer);
          pass.draw(command.vertices.length / 4);
        } else {
          const buffer = vertexBuffer(command.vertices);
          frameBuffers.push(buffer);
          pass.setPipeline(colorPipeline);
          pass.setBindGroup(0, currentSlot.bindGroup);
          pass.setVertexBuffer(0, buffer);
          pass.draw(command.vertices.length / 6);
        }
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
      for (const buffer of frameBuffers) buffer.destroy();
      commands = [];
    },
  };
}
