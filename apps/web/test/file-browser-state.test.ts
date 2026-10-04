import { expect, it } from "vitest";
import { FileBrowserStore } from "../src/features/files/state.ts";
const storage = () => {
  const values = new Map<string,string>();
  return { getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value); }, removeItem: (key:string) => { values.delete(key); } };
};
it("不同 Agent 的标签、选中、滚动和剪贴板相互独立，重新进入可恢复自己的状态", () => {
  const disk=storage();const a=new FileBrowserStore("A",disk);const b=new FileBrowserStore("B",disk);
  a.addTab("/projects/a");a.addTab("/outputs/a");b.addTab("/projects/b");
  a.patchTab(a.getFiles().active,{scroll:240,selected:["/outputs/a/result.txt"],query:"result"});
  a.setFiles({...a.getFiles(),clipboard:["/outputs/a/result.txt"],clipboardMode:"move"});
  expect(b.getFiles().tabs.map(t=>t.path)).toEqual(["/projects/b"]);
  expect(b.getFiles().clipboard).toEqual([]);expect(b.getFiles().tabs[0]!.scroll).toBe(0);
  expect(new FileBrowserStore("A",disk).getFiles()).toEqual(a.getFiles());
  expect(new FileBrowserStore("B",disk).getFiles()).toEqual(b.getFiles());
});
it("主动关闭只清空当前 Agent，延迟请求不能恢复旧状态，再打开从新的起点开始", () => {
  const disk=storage();const a=new FileBrowserStore("A",disk);const b=new FileBrowserStore("B",disk);
  a.addTab("/old-a");a.addTab("/old-a-2");b.addTab("/keep-b");const old=a.getFiles();
  a.close();a.addTab("/late-cwd");a.setFiles(old);a.patchTab(old.active,{path:"/late-write"});
  expect(a.getFiles().tabs).toEqual([]);
  const reopened=new FileBrowserStore("A",disk);expect(reopened.getFiles()).toMatchObject({tabs:[],clipboard:[],active:""});
  reopened.addTab("/new-agent-cwd");expect(reopened.getFiles().tabs.map(t=>t.path)).toEqual(["/new-agent-cwd"]);
  expect(new FileBrowserStore("B",disk).getFiles().tabs[0]!.path).toBe("/keep-b");
});
it("不将旧的全局文件状态复制给任何 Agent", () => {
  const disk=storage();disk.setItem("car.files.v2",JSON.stringify({tabs:[{id:"shared",path:"/shared",selected:[],query:""}],active:"shared",clipboard:["/shared/file"]}));
  expect(new FileBrowserStore("A",disk).getFiles().tabs).toEqual([]);
  expect(new FileBrowserStore("B",disk).getFiles().tabs).toEqual([]);
});
