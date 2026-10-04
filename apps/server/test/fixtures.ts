/**
 * 测试用的 cmux 原始 JSON 片段。
 * 字段名与真实 `cmux tree --all --json --id-format both`
 * 和 `cmux top --all --processes --json` 一致（结构照抄，内容是编造的）。
 */

export const RAW_TREE = {
  active: { surface_ref: "surface:11", workspace_ref: "workspace:5" },
  caller: { surface_ref: "surface:99", workspace_ref: "workspace:9" },
  windows: [
    {
      active: true,
      id: "WIN-1",
      index: 0,
      ref: "window:1",
      selected_workspace_ref: "workspace:5",
      workspace_count: 2,
      workspaces: [
        {
          active: true,
          description: null,
          id: "WS-WORLD",
          index: 0,
          ref: "workspace:5",
          selected: true,
          title: "世界模型 Demo",
          panes: [
            {
              active: true,
              focused: true,
              id: "PANE-7",
              index: 0,
              ref: "pane:7",
              selected_surface_ref: "surface:11",
              surface_count: 2,
              surfaces: [
                {
                  focused: false,
                  id: "SURF-10",
                  index: 0,
                  index_in_pane: 0,
                  pane_id: "PANE-7",
                  pane_ref: "pane:7",
                  ref: "surface:10",
                  selected: false,
                  selected_in_pane: false,
                  title: "codex — 世界模型 Demo",
                  tty: "ttys010",
                  type: "terminal",
                  url: null,
                },
                {
                  focused: true,
                  id: "SURF-11",
                  index: 1,
                  index_in_pane: 1,
                  pane_id: "PANE-7",
                  pane_ref: "pane:7",
                  ref: "surface:11",
                  selected: true,
                  selected_in_pane: true,
                  title: "codex — 评测流水线",
                  tty: "ttys011",
                  type: "terminal",
                  url: null,
                },
              ],
            },
            {
              active: false,
              focused: false,
              id: "PANE-8",
              index: 1,
              ref: "pane:8",
              surface_count: 1,
              surfaces: [
                {
                  focused: false,
                  id: "SURF-12",
                  index: 0,
                  index_in_pane: 0,
                  pane_id: "PANE-8",
                  pane_ref: "pane:8",
                  ref: "surface:12",
                  selected: true,
                  selected_in_pane: true,
                  title: "zsh",
                  tty: "ttys012",
                  type: "terminal",
                  url: null,
                },
              ],
            },
          ],
        },
        {
          active: false,
          description: null,
          id: "WS-EVAL",
          index: 1,
          ref: "workspace:6",
          selected: false,
          title: "业务评测平台",
          panes: [
            {
              active: false,
              focused: false,
              id: "PANE-9",
              index: 0,
              ref: "pane:9",
              surface_count: 1,
              surfaces: [
                {
                  focused: false,
                  id: "SURF-20",
                  index: 0,
                  index_in_pane: 0,
                  pane_id: "PANE-9",
                  pane_ref: "pane:9",
                  ref: "surface:20",
                  selected: true,
                  selected_in_pane: true,
                  title: "claude — 业务评测平台",
                  tty: "ttys020",
                  type: "terminal",
                  url: null,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const RAW_TOP = {
  coding_agents: [
    {
      asset_name: "AgentIcons/Claude",
      display_name: "Claude Code",
      id: "claude",
      resources: { pids: [7001, 7002, 7003] },
    },
    {
      asset_name: "AgentIcons/Codex",
      display_name: "Codex",
      id: "codex",
      resources: { pids: [5101, 5102, 5201] },
    },
  ],
  windows: [
    {
      ref: "window:1",
      workspaces: [
        {
          id: "WS-WORLD",
          ref: "workspace:5",
          panes: [
            {
              ref: "pane:7",
              surfaces: [
                {
                  ref: "surface:10",
                  processes: [
                    {
                      pid: 4001,
                      ppid: 1,
                      name: "zsh",
                      path: "/bin/zsh",
                      cmux_surface_id: "SURF-10",
                      cmux_workspace_id: "WS-WORLD",
                      children: [
                        {
                          pid: 5101,
                          ppid: 4001,
                          name: "codex",
                          path: "/Users/demo/.bun/bin/codex",
                          cmux_surface_id: "SURF-10",
                          children: [
                            { pid: 5102, ppid: 5101, name: "node", path: "/usr/bin/node", children: [] },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  ref: "surface:11",
                  processes: [
                    {
                      pid: 5201,
                      ppid: 1,
                      // Codex 有时会把进程名改成版本号，这时只能靠 coding_agents 的 pid 列表识别。
                      name: "0.48.0",
                      path: "/opt/codex/bin/codex-cli",
                      cmux_surface_id: "SURF-11",
                      children: [],
                    },
                  ],
                },
                {
                  ref: "surface:12",
                  processes: [
                    { pid: 4300, ppid: 1, name: "zsh", path: "/bin/zsh", cmux_surface_id: "SURF-12", children: [] },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "WS-EVAL",
          ref: "workspace:6",
          panes: [
            {
              ref: "pane:9",
              surfaces: [
                {
                  ref: "surface:20",
                  processes: [
                    {
                      pid: 7001,
                      ppid: 1,
                      name: "2.1.233",
                      path: "/Users/demo/.local/bin/claude",
                      cmux_surface_id: "SURF-20",
                      children: [{ pid: 7002, ppid: 7001, name: "node", children: [] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export const RAW_READ_SCREEN = {
  base64: Buffer.from(
    "\u001b[2m$\u001b[0m codex\r\nRunning pnpm test...\r\n\r\n\r\n\r\n14 tests passed  \r\n2 tests failed\r\n",
  ).toString("base64"),
  surface_id: "SURF-11",
  surface_ref: "surface:11",
  text: "trimmed",
  window_id: "WIN-1",
  window_ref: "window:1",
  workspace_id: "WS-WORLD",
  workspace_ref: "workspace:5",
};
