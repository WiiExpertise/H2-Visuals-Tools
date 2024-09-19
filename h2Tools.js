(async() => {
	// Required modules
	const fs = require('fs');
	const { promisify } = require('node:util');
	const zlib = require('zlib');
	const deflate = promisify(zlib.deflate);
	const inflate = promisify(zlib.inflate);
	const prompt = require('prompt-sync')();
	const { BitView } = require('bit-buffer');

	// Required lookup files
	const slotNumLookup = JSON.parse(fs.readFileSync('lookupFiles/slotNumLookup.json', 'utf8'));
	const fieldLookup = JSON.parse(fs.readFileSync('lookupFiles/fieldLookup.json', 'utf8'));
	const enumLookup = JSON.parse(fs.readFileSync('lookupFiles/enumLookup.json', 'utf8'));

	// Field type constants
	const FIELD_TYPE_INT = 0;
	const FIELD_TYPE_STRING = 1;
	const FIELD_TYPE_ARRAY = 4;
	const FIELD_TYPE_FLOAT = 10;

	// Global data buffer for reading
	let fileData;

	// Convert object keys to lowercase
	function normalizeKeys(obj) 
	{
		return Object.keys(obj).reduce((acc, key) => {
			acc[key.toLowerCase()] = obj[key];
			return acc;
		}, {});
	}

	// Function to read a modified LEB128 encoded number
	function readModifiedLebEncodedNumber()
	{
		let byteArray = [];
		let currentByte;

		do
		{
			currentByte = readByte().readUInt8(0);
			byteArray.push(currentByte);
		}
		while((currentByte & 0x80));
		
		let value = 0;
		let isNegative = false;

		const buf = Buffer.from(byteArray);

		for (let i = (buf.length - 1); i >= 0; i--) {
			let currentByte = buf.readUInt8(i);

			if (i !== (buf.length - 1)) {
			currentByte = currentByte ^ 0x80;
			}

			if (i === 0 && (currentByte & 0x40) === 0x40) {
			currentByte = currentByte ^ 0x40;
			isNegative = true;
			}

			let multiplicationFactor = 1 << (i * 6);

			if (i > 1) {
			multiplicationFactor = multiplicationFactor << 1;
			}

			value += currentByte * multiplicationFactor;

			if (isNegative) {
			value *= -1;
			}
		}

		return value;
	}

	// Function to convert a number to the modified LEB128 encoding
	function writeModifiedLebEncodedNumber(value) 
	{
		const isNegative = value < 0;
		value = Math.abs(value);
	
		if (value <= 63) 
		{
			const buffer = Buffer.from([value]);
			const bv = new BitView(buffer, buffer.byteOffset);
		
			if (isNegative) 
			{
				bv.setBits(6, 1, 1);
			}
		
			return buffer;
		}
		else if (value > 63 && value < 8192) 
		{
			const buffer = Buffer.from([0x0, 0x0]);
			const bv = new BitView(buffer, buffer.byteOffset);
			
			const lowerBitValue = value % 64;
			bv.setBits(0, lowerBitValue, 6);
		
			if (isNegative) 
			{
				bv.setBits(6, 1, 1);
			}
		
			bv.setBits(7, 1, 1);
			
			const higherBitValue = Math.floor(value / 64);
			bv.setBits(8, higherBitValue, 8);
		
			return buffer;
			}
			else 
			{
			const buffer = Buffer.from([0x0, 0x0, 0x0]);
			const bv = new BitView(buffer, buffer.byteOffset);
		
			const lowerBitValue = value % 64;
			bv.setBits(0, lowerBitValue, 6);
		
			if (isNegative)
			{
				bv.setBits(6, 1, 1);
			}
		
			bv.setBits(7, 1, 1);
			
			const midBitValue = Math.floor((value - 8192) / 64);
			bv.setBits(8, midBitValue, 7);
			bv.setBits(15, 1, 1);
		
			const highBitValue = Math.floor(value / 8192);
			bv.setBits(16, highBitValue, 8);
		
			return buffer;
		}
	}

	// Global offset for reading the buffer
	let offset = 0;

	// Function to read a specified number of bytes from the buffer
	function readBytes(length) 
	{
		const bytes = fileData.subarray(offset, offset + length);
		offset += length;
		return bytes;
	}

	// Function to read a single byte from the buffer
	function readByte() 
	{
		return fileData.subarray(offset++, offset);
	}

	// Function to pad the buffer to the specified alignment
	function pad(alignment)
	{
		while(offset % alignment !== 0)
		{
			offset++;
		}
	}

	// Function to get uncompressed text from a 6-bit compressed buffer
	function getUncompressedTextFromSixBitCompression(data) 
	{
		const bv = new BitView(data, data.byteOffset);
		bv.bigEndian = true;
		const numCharacters = (data.length * 8) / 6;
		
		let text = '';
	
		for (let i = 0; i < numCharacters; i++) 
		{
			text += String.fromCharCode(getCharCode(i * 6));
		}
	
		return text;
	
		function getCharCode(offset) 
		{
			return bv.getBits(offset, 6) + 32;
		}
	}

	// Function to convert a character to a 6-bit value
	function charTo6Bit(c) {
		// Map A-Z to 0-25, 0-9 to 26-35
		if (c >= 'A' && c <= 'Z') 
		{
			return (c.charCodeAt(0) - 32);
		}
		else if (c >= '0' && c <= '9') 
		{
			return c.charCodeAt(0) - 32;
		}
		throw new Error("Unsupported character: " + c);
	}
	
	// Function to compress a 4 character string to a 3 byte representation
	function compress6BitString(str) 
	{
		if (str.length !== 4) 
		{
			throw new Error("Input string must be exactly 4 characters");
		}
	
		// Convert each character to 6-bit value
		let bits = [];
		for (let i = 0; i < 4; i++) 
		{
			bits.push(charTo6Bit(str[i]));
		}
	
		// Pack the 6-bit values into 3 bytes
		let byte1 = (bits[0] << 2) | (bits[1] >> 4);
		let byte2 = ((bits[1] & 0xF) << 4) | (bits[2] >> 2);
		let byte3 = ((bits[2] & 0x3) << 6) | bits[3];
	
		return [byte1, byte2, byte3];
	}

	// Function to decompress a gzip compressed buffer
	async function decompressBuffer(compressedBuffer) 
	{
		try 
		{
			const result = zlib.gunzipSync(compressedBuffer);
			return result;
		} 
		catch (err) 
		{
			console.error('An error occurred during inflation:', err);
		}
	}

	// Function to read records from an H2 file
	async function readRecords()
	{
		// Set up data buffer
		console.log("\nEnter the path to the H2 archive file: ");
		const visualsPath = prompt().trim().replace(/['"]/g, '');
		fileData = fs.readFileSync(visualsPath);

		// Read the start of the file
		const tableBytes = readBytes(3);
		const tableName = getUncompressedTextFromSixBitCompression(tableBytes);
		const type = readByte().readUInt8(0);
		const unkBytes = readBytes(2);
		const recordCount = readModifiedLebEncodedNumber();

		
		console.log("\nEnter the path to the folder where you want to save the records: ");
		const recordsPath = prompt().trim().replace(/['"]/g, '');
		
		if(recordsPath.endsWith("/"))
		{
			recordsPath = recordsPath.slice(0, -1);
		}
				
		console.log(`\nTable Name: ${tableName}`);
		console.log(`Type: ${type}`);
		console.log(`Record count: ${recordCount}`);

		console.log("\nNow working on decompressing the records...");

		// If the records folder doesn't exist, create it
		if(!fs.existsSync(recordsPath))
		{
			fs.mkdirSync(recordsPath);
		}

		// Read each record
		for(let i = 0; i < recordCount; i++)
		{
			const recordKey = readModifiedLebEncodedNumber();
			const recordByteSize = readModifiedLebEncodedNumber();

			const recordData = readBytes(recordByteSize);
			const decompressedData = await decompressBuffer(recordData);

			fs.writeFileSync(recordsPath + "/" + recordKey + ".dat", decompressedData);
		}

		console.log(`\nRecords decompressed and saved to ${recordsPath}!`);
	}

	// Function to write records to an H2 file
	async function writeRecords(recordsPath = null, outputName = null)
	{
		if(!recordsPath)
		{
			// Enter the path to the records folder
			console.log("\nEnter the path to the folder containing the records:");
			recordsPath = prompt().trim().replace(/['"]/g, '');
		}

		if(recordsPath.endsWith("/"))
		{
			recordsPath = recordsPath.slice(0, -1);
		}

		if(!outputName)
		{
			// Enter the name of the output file
			console.log("\nEnter the name of the output file (without extension):");
			outputName = prompt().trim().replace(/['"]/g, '');
		}
		
		// Enumerate the records in the records folder
		const files = fs.readdirSync(recordsPath);

		// Sort the files in ascending order
		files.sort((a, b) => parseInt(a.split(".")[0]) - parseInt(b.split(".")[0]));
		
		const newRecordCount = writeModifiedLebEncodedNumber(files.length);

		const unkBytes = Buffer.from([0x00, 0x02]);
		const tableBytes = Buffer.from(compress6BitString("PLEX"));

		// Write the beginning of the file
		let headerBuffer = Buffer.alloc(6 + newRecordCount.length);
		tableBytes.copy(headerBuffer, 0);
		headerBuffer[3] = 0x05;
		unkBytes.copy(headerBuffer, 4);
		newRecordCount.copy(headerBuffer, 6);

		let recordBufferArray = [];

		// Iterate through each record file
		for(const file of files)
		{
			const recordKey = parseInt(file.split(".")[0]);
			const recordData = fs.readFileSync(recordsPath + "/" + file);

			const compressedData = zlib.gzipSync(recordData);

			const recordKeyBuffer = writeModifiedLebEncodedNumber(recordKey);
			const recordSizeBuffer = writeModifiedLebEncodedNumber(compressedData.length);

			const recordBuffer = Buffer.concat([recordKeyBuffer, recordSizeBuffer, compressedData]);

			recordBufferArray.push(recordBuffer);
		}

		for(const recordBuffer of recordBufferArray)
		{
			headerBuffer = Buffer.concat([headerBuffer, recordBuffer]);
		}

		fs.writeFileSync(outputName + ".H2", headerBuffer);

		console.log(`\nRecords written to ${outputName}.H2!`);

	}

	// Function to write a CHVI record based on a JSON object
	function writeChviRecord(objectData)
	{
		const recordBufferArray = [];

		let keys = Object.keys(objectData);
		let order = [];

		// Hack to ensure everything is ordered correctly
		if(keys.includes("slotType"))
		{
			if(keys.includes("blends"))
			{
				order.push("blends")
				if(keys.includes("itemAssetName"))
				{
					order.push("itemAssetName");
				}
			}
			else if(keys.includes("itemAssetName"))
			{
				order.push("itemAssetName");
			}

			order.push("slotType");

			keys = order;
		}
		else if(keys.includes("loadouts"))
		{
			keys = ["assetName", "bodyType", "firstName", "jerseyNumber", "lastName", "containerId", "genericHeadName", "genericHead", "heightInches", "loadouts", "skinTone", "skinToneScale", "weightPounds"];
		}

		for(let key of keys)
		{		
			if(!fieldLookup.hasOwnProperty(key) || !objectData.hasOwnProperty(key))
			{
				continue;
			}

			
			let field = fieldLookup[key];

			if(objectData[key] === "GearOnly")
			{
				field = {
					key: "LDTY",
					type: FIELD_TYPE_INT
				}

				key = "loadoutType";
			}

			let valueToWrite = objectData[key];

			if(field.key === "SLOT")
			{
				let lowerCaseSlotLookup = normalizeKeys(slotNumLookup);
				valueToWrite = lowerCaseSlotLookup[valueToWrite.toLowerCase()];

			}
			else if(field.key === "USKT")
			{
				recordBufferArray.push(...compress6BitString(field.key));
				recordBufferArray.push(field.type);
				recordBufferArray.push(0xC0, 0xFE, 0xFB, 0x07);
				continue;
			}
			else if(field.key === "GENR")
			{
				// Extra unknown field
				recordBufferArray.push(0x8E, 0xFB, 0x62, 0x03, 0x00);
			}
			else if(field.type === FIELD_TYPE_INT && typeof valueToWrite === "string")
			{
				if(enumLookup.hasOwnProperty(key) && enumLookup[key].hasOwnProperty(valueToWrite))
				{
					valueToWrite = enumLookup[key][valueToWrite];
				}
				else
				{
					valueToWrite = parseInt(valueToWrite);
				}
			}

			recordBufferArray.push(...compress6BitString(field.key));
			recordBufferArray.push(field.type);

			if(field.type === FIELD_TYPE_INT)
			{
				let numberBytes = [...writeModifiedLebEncodedNumber(valueToWrite)];
				recordBufferArray.push(...numberBytes);
			}
			else if(field.type === FIELD_TYPE_STRING)
			{
				let stringBytes = [...Buffer.from(valueToWrite, 'utf8')];
				stringBytes.push(0x00);
				let stringLengthBytes = [...writeModifiedLebEncodedNumber(stringBytes.length)];
				recordBufferArray.push(...stringLengthBytes); 
				recordBufferArray.push(...stringBytes);
			}
			else if(field.type === FIELD_TYPE_FLOAT)
			{
				let floatBytes = Buffer.alloc(4);
				floatBytes.writeFloatBE(valueToWrite);
				recordBufferArray.push(...floatBytes);
			}
			else if(field.type === FIELD_TYPE_ARRAY)
			{
				// Unknown byte
				recordBufferArray.push(0x03);

				// Number of elements in the array
				recordBufferArray.push(valueToWrite.length);

				for(const element of valueToWrite)
				{
					let elementBytes = writeChviRecord(element);
					recordBufferArray.push(...elementBytes);
					
					// Each element is followed by a 0x00 byte
					recordBufferArray.push(0x00);
				}
			}
		}

		return recordBufferArray;
	}

	// Function to convert league visuals JSON to H2 file
	async function convertLeagueVisualsToH2()
	{
		// Set up data buffer
		console.log("\nEnter the path to the league visuals JSON file: ");
		const visualsPath = prompt().trim().replace(/['"]/g, '');
		const visualsJsonData = JSON.parse(fs.readFileSync(visualsPath, 'utf8'))["characterVisualsPlayerMap"];

		// Iterate through each key in the JSON data
		const keys = Object.keys(visualsJsonData);

		// If the convertedRecords folder doesn't exist, create it
		if(!fs.existsSync("convertedRecords"))
		{
			fs.mkdirSync("convertedRecords");
		}
		else
		{
			// Clear out the convertedRecords folder
			fs.rmSync("convertedRecords", { recursive: true });
			fs.mkdirSync("convertedRecords");
		}

		for(const key of keys)
		{
			// Common entry header
			let recordBytes = [0x8E, 0x8D, 0xA9, 0x03];

			// Write the record data
			recordBytes.push(...writeChviRecord(visualsJsonData[key]));

			// Each record is concluded by a 0x00 byte
			recordBytes.push(0x00);

			// Write the record to a file
			const recordBuffer = Buffer.from(recordBytes);
			fs.writeFileSync(`convertedRecords/${key}.dat`, recordBuffer);
		}

		// Output file info
		console.log("\nEnter the name of the output file (without extension):");
		const outputName = prompt().trim().replace(/['"]/g, '');

		// Write the records to the output file
		await writeRecords("convertedRecords", outputName);
		
	}

	const options = ["Read records from H2 file", "Write records to H2 file", "Convert leaguevisuals JSON to H2 file", "Exit program"]; 

	// Main program logic
	console.log("Welcome to H2 Visuals Tools! This program will help you read, write, and convert H2 visuals files.\n");
	
	do
	{
		console.log("MAIN MENU:")
		options.forEach((option, index) => {
			console.log(`${index + 1}. ${option}`);
		});

		console.log("\nEnter the number of the option you'd like to select: ");

		let option = parseInt(prompt().trim());

		if(option < 1 || option > options.length || option === NaN)
		{
			console.log("Invalid option. Please enter a valid option.");
			continue;
		}

		if(option === 1)
		{
			await readRecords();
		}
		else if(option === 2)
		{
			await writeRecords();
		}
		else if(option === 3)
		{
			await convertLeagueVisualsToH2();
		}
		else if(option === 4)
		{
			break;
		}

		console.log("\n");

	}
	while(true);

	

})();