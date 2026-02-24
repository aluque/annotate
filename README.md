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

## Usage
Open one image or drop it into the app canvas. Then select the type of annotation that you want and put it on top of the image. The left column can be used to edit the annotation label or remove them. In the lower left there is a column to define tags for annotations, which can later be selected. The main use case for tags is to differentiate between datasets in a plot. 

## Tools
The *Tools* menu contain common use cases for annotations. Some of them depend on particular naming of line annotations to identify them as axes in a plot or as measure scales. 

To define axes that allow the use of the *Extract* tool use the format `name: start end` where `start` and `end` are the values that the data takes at the start and end of the axis (for example an *x* axes that goes from 0 to 10 can be defined as "x: 0 10"). Add an L for a log scale (e.g. "x: 1e-4 1e4 L").
You can define as many axes as you want although the most common case is having one horizontal and one vertical axes.

To define a scale for measuring distances (for example a line in the image that specifies "50 m") use a similar notation as for axes but providing the length (with units dropped): "s: 50". The scale name ("s" here) is arbitrary. You can define as many scales as you want. Scales are used in the *Measure*, *Profile*, *Distances* and *Area* tools.

All tools export a CSV file.

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

