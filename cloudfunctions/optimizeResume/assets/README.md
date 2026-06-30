# PDF字体

中文PDF生成需要一个支持中文的字体文件。

请放置任意 `.ttf` 或 `.otf` 字体文件。

代码会优先查找以下文件：

- `resume-font.ttf`
- `resume-font.otf`

也会自动识别该目录下其他 `.ttf` / `.otf` 文件，例如：

```text
cloudfunctions/optimizeResume/assets/hanchanhuokaiti.otf
```

建议使用你有权商用的开源中文字体，例如思源黑体/Noto Sans CJK 的简体中文版本。
