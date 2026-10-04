import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness } from "./helpers.ts";
import { FileService } from "../src/services/files.ts";
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "car-media-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("识别视频音频，不把媒体作为文本截断", async () => {
  const f = new FileService();
  for (const [name,kind] of [["clip.MP4","video"],["song.mp3","audio"],["voice.wav","audio"],["movie.mov","video"]]) {
    const path = join(root,name!); await writeFile(path,"fixture");
    expect(await f.preview(path)).toMatchObject({kind,truncated:false});
  }
});
it("媒体请求需要登录，支持完整读取、HEAD、区间、后缀及无效范围", async () => {
  const h=await createHarness(); const cookie=await h.loginCookie(); const path=join(root,"sample.mp4"); await writeFile(path,"0123456789");
  const url=`/api/files/media?path=${encodeURIComponent(path)}`;
  expect((await h.request(url)).status).toBe(401);
  const full=await h.request(url,{cookie}); expect(full.status).toBe(200); expect(full.headers.get("content-type")).toBe("video/mp4"); expect(await full.text()).toBe("0123456789");
  const head=await h.request(url,{cookie,method:"HEAD"}); expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe("");
  for (const [range,expected,contentRange] of [["bytes=2-5","2345","bytes 2-5/10"],["bytes=7-","789","bytes 7-9/10"],["bytes=-3","789","bytes 7-9/10"],["bytes=8-99","89","bytes 8-9/10"]]) {
    const r=await h.request(url,{cookie,headers:{range:range!,"accept-encoding":"gzip"}});
    expect(r.status).toBe(206); expect(r.headers.get("content-range")).toBe(contentRange); expect(r.headers.get("content-length")).toBe(String(expected!.length)); expect(r.headers.get("content-encoding")).toBeNull(); expect(await r.text()).toBe(expected);
  }
  for (const range of ["bytes=10-","bytes=5-2","bytes=-0","bytes=-","bytes=0-1,4-5","bad"]) {
    const r=await h.request(url,{cookie,headers:{range}});expect(r.status).toBe(416);expect(r.headers.get("content-range")).toBe("bytes */10");
  }
  await writeFile(join(root,"page.html"),"<script>alert(1)</script>");
  expect((await h.request(`/api/files/media?path=${encodeURIComponent(join(root,"page.html"))}`,{cookie})).status).toBe(400);
});
it("超过 20 MB 的媒体按需分段读取，空文件和取消不会挂住", async () => {
  const h=await createHarness();const cookie=await h.loginCookie();const path=join(root,"large.wav");const f=await open(path,"w");await f.truncate(25*1024*1024);await f.close();
  const url=`/api/files/media?path=${encodeURIComponent(path)}`;
  const r=await h.request(url,{cookie,headers:{range:"bytes=22000000-22000015"}});expect(r.status).toBe(206);expect((await r.arrayBuffer()).byteLength).toBe(16);
  const stream=await h.request(url,{cookie});await stream.body!.cancel();
  await writeFile(join(root,"empty.mp3"),"");const empty=`/api/files/media?path=${encodeURIComponent(join(root,"empty.mp3"))}`;
  expect((await h.request(empty,{cookie,headers:{range:"bytes=0-"}})).status).toBe(416);
  expect(await (await h.request(empty,{cookie})).text()).toBe("");
});
