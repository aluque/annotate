"""
This script can be used together with the 'annotate' app to extract data from images of plots.

How to use:

- In the annotation app define scales as lines and name them as e.g.
  "<NAME>: <length>" where <NAME> is the scale name and
  <length> is a physical length (expressed without units).
  Then add line annotations, optionally with tags if you want to identify several
  series in the same plot. Download the .json with the annotations.

- Call this script as

```
python measure.py filename_annotations.json -o output.csv [--tag tag]
```

If `--tag` is omitted, all lines are extracted to the csv file.

"""

## Some notes:
## Although the annotate app was basically done by Claude, this script was written entirely by the
## human A. Luque.
## Some math operation would be more concise using vectors but I intentionally did not want to add
## any non-standard dependency for such as simple task.

import argparse
import json
import math
import re

class Axis(object):
    """
    As Axis instance contains the data required to project points into an axis.
    """
    def __init__(self, name, r0, r1, physlen):
        self.name = name
        self.r0 = r0
        self.r1 = r1
        self.delta = [r1[0] - r0[0], r1[1] - r0[1]]
        self.l2 = (r1[0] - r0[0])**2 + (r1[1] - r0[1])**2
        self.l = math.sqrt(self.l2)
        self.physlen = physlen
        self.unitperpx = self.physlen / self.l
        
def getscales(data):
    """
    Look for lines in the annotations that mark a scale.  They are specified in the name of the
    line as "<NAME>: <length>" where <NAME> is the scale name and <length> is the physical length
    of the line (with units omitted)

    Note that a plot can have as many scales as you want: they will all be included as columns in the
    output.
    """
    r = re.compile(r"(?P<name>\w+):\s*(?P<length>[\d.efg+-]+)")
    axes = []
    
    for item in data["annotations"]:
        if item["type"] != "line":
            continue
        
        if m := r.match(item["name"]):
            # print(f"Axes found {item['name']}")
            name = m.group("name")
            r0 = item["coords"][0]
            r1 = item["coords"][1]
            physlen = float(m.group("length"))
            
            axes.append(Axis(name, r0, r1, physlen))

    return axes

def extract(data, scales, tag=None):
    """
    Looks for lines in the data and measures their length using the scale lengths.
    If `tag` is not `None` only lines with that tag are included.
    """
    col = {sc.name : [] for sc in scales}
    names = []
    
    for item in data["annotations"]:
        if item["type"] != "line":
            continue

        if tag and tag not in item["tags"]:
            continue

        names.append(item["name"])
        
        c = item["coords"]
        
        for sc in scales:
            v = math.sqrt((c[1][0] - c[0][0])**2 + (c[1][1] - c[0][1])**2) * sc.unitperpx
            col[sc.name].append(v)

    return (names, col)

def export(fout, names, col):
    """
    Exports the data to a .csv file. Currently it may not be very robust but I don't want to add
    a dependency for a proper csv library.
    """
    keys = list(col.keys())
    keys.sort()
    
    if len(keys) == 0:
        # Nothing to do
        return
        
    fout.write("name" + "," + ",".join(csv_sanitize(name) for name in keys) + "\n")
    n = len(col[keys[0]])
    for i in range(n):
        fout.write(names[i] + "," + ",".join(str(col[k][i]) for k in keys) + "\n")


def csv_sanitize(s):
    """
    Very simple csv sanitizer that fixes strings with commas.
    """
    if "," in s:
        return f'"{s}"'
    else:
        return s
    
def main():
    parser = argparse.ArgumentParser(description="Extract data from image annotations")
    parser.add_argument("input", help=".json file with the annotations")
    parser.add_argument(
        "--tag",
        type=str,
        default="",
        help=f"Extract data only with this tag (default: all tags)",
    )

    parser.add_argument(
        "--output", "-o",
        type=argparse.FileType('w', encoding='UTF-8'),
        default="-",
        help=f"Output file (default: stdout)",
    )
    
    args = parser.parse_args()
    
    with open(args.input) as f:
        data = json.load(f)

    axes = getscales(data)
    names, col = extract(data, axes, tag=args.tag)
    export(args.output, names, col)
    
if __name__ == '__main__':
    main()
