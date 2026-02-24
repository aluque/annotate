# Annotate - An image annotation tool

**Live app: https://aluque.github.io/annotate/**

## Description
This is a no-installation, browser-only app to annotate parts of an image. The annotations can be downloaded as a JSON file and tools are provided for the most common use cases for image annotations:

- Extract datapoints from plots available only as bitmap images.
- Measure distances inside the image.
- Obtain the RGB and luminance curves along lines.
- Measure angles.
- Measure pairwise point distances.
- Measure rectangle dimensions and areas.

This is an experiment in the use of generative AI to develop small handy tools for scientists. I have often looked for a minimal application like this but, although there are many software packages and web apps that allow something similar, none of them was exactly to my liking. This is the kind of problem where generative AI tools excel: with little effort something can be produced that is not dramatically original but accurately follows your preferences.

## FAQ
**Q:** What coding agent did you use?
**A:** Claude Code.

**Q:** Is the code totally AI generated.
**A:** Yes, the app code is fully AI generated. I am not fluent with CSS and JS. I wrote the python scripts in the `scripts/` to implement common uses of the downloaded JSON but then I thought that I can ask Claude to rewrite them in JS and incorporate them into the app. Then I added more possibly useful tools.

**Q:** How long did it take?
**A:** All together a few hours in Claude sessions but I was typically doing other stuff at the same time and interacting with Claude about every 10 minutes or so.

**Q:** Did you use Claude Code for something similar?
**A:** Yes! I ported [QtPlaskin](https://github.com/aluque/qtplaskin), an old python application to analyze chemical data, to run inside the browser using JS. See it live here: https://aluque.github.io/jsplaskin/ .

**Q:** Is this text AI generated?
**A:** No, no AI slop here. I wrote this document without AI intervention.

