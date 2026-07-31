import { describe, expect, it } from "vitest";

import { splitReadableParagraph } from "./markdown";

describe("readable paragraph splitting", () => {
  it("splits long assistant-style Chinese paragraphs at sentence boundaries", () => {
    const text =
      "我先定位每日趋势的组件和对应样式，确认右侧图例的 DOM 结构后只改相关 CSS。" +
      "每日趋势在 `StatisticsCenter`，右侧图例是两个 span 内容和色块。" +
      "现在看具体样式，应该只需要给图例项或色块加 gap 和 margin。" +
      "结构确认了，我会用现有间距尺度加一个很小的间隔，不改组件结构。";

    const paragraphs = splitReadableParagraph(text);

    expect(paragraphs.length).toBeGreaterThan(1);
    expect(paragraphs.join("")).toBe(text);
  });

  it("leaves existing manually wrapped text alone", () => {
    const text =
      "第一段已经由模型自己换行。\n" +
      "第二行继续说明，所以显示层不应该再二次拆分。";

    expect(splitReadableParagraph(text)).toStrictEqual([text]);
  });
});
