# H2 Visuals Tools
This tool allows for reading and writing EA Sports H2 archive files, typically used for CharacterVisuals data.

## Supported functionality
- Extract records from H2 archive to .dat
- Write .dat records to H2 archive
- Convert legacy CharacterVisuals JSON files to H2 archive

## Usage
1. Download the latest executable from [releases](https://github.com/WiiExpertise/h2-visuals-tools/releases/latest)
2. Run the executable and follow the included prompts

## Building
1. Clone the repository:
   ```bash
    git clone https://github.com/your-username/h2-visuals-tools.git
    ```
2. Navigate to the project directory:
 
    ```bash
    cd h2-visuals-tools
    ```
3. Install dependencies:

    ```bash
    npm install
    ```
4. Run the tool:

    ```bash
    node h2Tools.js
    ```
## Building Executable
To build this tool into an executable, you can use [nexe](https://github.com/nexe/nexe). To install nexe globally:

```bash
npm install -g nexe
```

Please note that nexe requires both Python and NASM to be installed. You can download Python [here](https://www.python.org/downloads/) (version 3.9 is recommended). You can download NASM [here](https://www.nasm.us/).

Once you have nexe installed, you can simply run the ``buildExe.bat`` script included with this repository. Feel free to modify it if needed to fit your application.

## How It Works
The H2 archive is extremely similar to the ``TDB2`` format that has been used for roster files since Madden 21. If you are unfamiliar, you can check out bep713's [madden-file-tools](https://github.com/bep713/madden-file-tools) API which parses TDB2 files among several other file types.

With H2, one of the key differences compared to a standard TDB2 table is that it is a table containing individually compressed data chunks. For example, the ``leaguevisuals.H2`` file used by Madden represents a table called ``PLEX``. This table contains 3027 records (a number which is also written to the H2 file), each of which is a gzip compressed block of data. The PLEX table provides two pieces of information for each compressed block in the series of bytes preceding it: the container ID corresponding to the player represented by the compressed block, and the length of the compressed block. Both numbers are stored in a modified LEB-128 encoding.

Once you read/decompress a data chunk, you get another file that is very similar to the TDB2 format. This time, it's a table called ``CHVI``. Each instance of this table only contains one record. The only difference between this and a standard TDB2 file is that it adds a new field type: array (4). This new field type allows for storing variable arrays of TDB2 fields, which is used for storing loadout and blend information in CharacterVisuals.

This tool works by taking the H2 file, reading each compressed chunk, decompressing it using ``zlib.gunzip``, and dumping all of the decompressed records into a folder. When writing back to H2, the tool writes the number of decompressed records to the H2 file, compresses each record with ``zlib.gzip``, and then writes all the records to file, including header information. Finally, when converting from a JSON to H2, the tool parses the JSON object, and then iterating through each player record, it writes each field in the object to a decompressed record file before following the same process as writing back to H2.

## Acknowledgements
Thanks to the following people for their contributions:
- **bep713** - For always being willing to answer questions and providing some direction to get me started with understanding this format
- **stingray68** - Helping me figure out recompressing the entries back into H2
- **primetime02454** - Providing motivation and a reason to get this done as well as testing things for me
- **Sinthros** - Getting me familiarized with JavaScript and helping me out when I run into issues
