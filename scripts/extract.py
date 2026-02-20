"""
This script can be used together with the 'annotate' app to extract data from images of plots.

How to use:

- In the annotation app define the plot axes as lines and name them as e.g.
  "<NAME>: <first_val> <second_val> [L]" where <NAME> is the axis name (can be X, Y or
  something arbitrary) and <first_val> and <second_val> are the values that the plotted variables
  takes at the starting and ending point of the axis. Optionally an L flag indicates that the axis
  is log-scaled. Then add point annotations, optionally with tags if you want to identify several
  series in the same plot. Download the .json with the annotations.

- Call this script as

```
python extract.py filename_annotations.json -o output.csv [--tag tag]
```

If `--tag` is omitted, all points are extracted to the csv file.

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
    def __init__(self, name, r0, r1, a, b, islog):
        self.name = name
        self.r0 = r0
        self.r1 = r1
        self.islog = islog
        self.delta = [r1[0] - r0[0], r1[1] - r0[1]]
        self.l2 = (r1[0] - r0[0])**2 + (r1[1] - r0[1])**2
        self.l = math.sqrt(self.l2)
        self.a = a if not self.islog else math.log(a)
        self.b = b if not self.islog else math.log(b)
        
def getaxes(data):
    """
    Look for lines in the annotations that mark an axis.  They are specified in the name of the
    line as "<NAME>: <first_val> <second_val> [L]" where <NAME> is the axis name (can be X, Y or
    something arbitrary) and <first_val> and <second_val> are the values that the plotted variables
    takes at the starting and ending point of the axis. Optionally an L flag indicates that the axis
    is log-scaled.

    Note that a plot can have as many axes as you want: they will all be included as columns in the
    output.
    """
    r = re.compile(r"(?P<name>\w+):\s*(?P<a>[\d.efg+-]+)\s+(?P<b>[\d.efg+-]+)\s*(?P<islog>L?)")
    axes = []
    
    for item in data["annotations"]:
        if item["type"] != "line":
            continue
        
        if m := r.match(item["name"]):
            # print(f"Axes found {item['name']}")
            name = m.group("name")
            a = float(m.group("a"))
            b = float(m.group("b"))
            islog = m.group("islog") == "L"
            r0 = item["coords"][0]
            r1 = item["coords"][1]
            
            axes.append(Axis(name, r0, r1, a, b, islog))

    return axes

def extract(data, axes, tag=None):
    """
    Looks for points in the data and maps (projects) them to the `axes`. If `tag` is not `None` only
    points with that tag are included.
    """
    col = {ax.name : [] for ax in axes}
    for item in data["annotations"]:
        if item["type"] != "point":
            continue

        if tag and tag not in item["tags"]:
            continue

        c = item["coords"]
        
        for ax in axes:
            v = ax.a + (ax.b - ax.a) * ((c[0] - ax.r0[0]) * ax.delta[0] +
                                        (c[1] - ax.r0[1]) * ax.delta[1]) / ax.l2
            if ax.islog:
                v = math.exp(v)
            
            col[ax.name].append(v)

    return col

def export(fout, col):
    """
    Exports the data to a .csv file. Currently it may not be very robust but I don't want to add
    a dependency for a proper csv library.
    """
    keys = list(col.keys())
    keys.sort()
    if len(keys) == 0:
        # Nothing to do
        return
        
    fout.write(",".join(csv_sanitize(name) for name in keys) + "\n")
    n = len(col[keys[0]])
    for i in range(n):
        fout.write(",".join(repr(col[k][i]) for k in keys) + "\n")


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

    axes = getaxes(data)
    col = extract(data, axes, tag=args.tag)
    export(args.output, col)
    
if __name__ == '__main__':
    main()
