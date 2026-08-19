export async function copyImageSourceToClipboard(
  src: string,
  fallbackMimeType = "image/png",
): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error("当前环境不支持复制图片");
  }

  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`读取图片失败: ${response.status}`);
  }

  let blob = await response.blob();
  const mimeType = blob.type || fallbackMimeType;
  if (!mimeType.startsWith("image/")) {
    throw new Error(`不支持的图片类型: ${mimeType}`);
  }
  if (blob.type !== mimeType) {
    blob = new Blob([await blob.arrayBuffer()], { type: mimeType });
  }

  await navigator.clipboard.write([
    new ClipboardItem({
      [mimeType]: blob,
    }),
  ]);
}
