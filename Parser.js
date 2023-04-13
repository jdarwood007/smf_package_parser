/*
 * Simple way to handle translation using a C# like Format for variable replacements.  Used for i18n.
*/
String.prototype.format = function() {return [...arguments].reduce((rt,cv,ci) => rt.replace("{" + ci + "}", cv), this);};
txt = [];

/* Some variables we pass around to other functions*/
usingArchive = 'zip';
archiveData = null;
instructions = [];

/* Handles the event when we upload */
async function uploadFileToJS(evt)
{
	console.debug('Processing Uploaded file');

	// Disable the event listners, so we can grab the SMF version data and repopulate data without triggering changes.
	disableVersionChangeListiners();
	archiveData = null;
	await fetchSmfVersions().then(populateSmfVersions);

	// Reading the file data into something.
	let reader = new FileReader();
	reader.onload = async function(evt) {
		console.debug('Waiting on File Reader');
		if(evt.target.readyState != 2)
			return;
		if(evt.target.error) {
			throw new Error ('Unable to read uploaded file');
			return;
		}

		let header = '';
		const arr = (new Uint8Array(evt.target.result)).subarray(0, 4);
		for (let j = 0; j < arr.length; j++) {
			header += arr[j].toString(16);
		}

		// Zip
		if (header == '504b34')
		{
			console.debug('Sending to Zip Handler');
			usingArchive = 'zip';

			JSZip.loadAsync(evt.target.result)
				.then(processZipFile).catch(function (e) {
					document.getElementById('errorContainer').removeAttribute('hidden');
					document.getElementById('errorContainer').innerHTML = e;
				});
		}
		// Tar.gz
		/*
			1f8b80: Unix compressed file 
			1f8b88: FAT/MS DOS file system
		*/
		else if (header == '1f8b80' || header == '1f8b88')
		{
			console.debug('Sending to Tgz Handler');
			usingArchive = 'tgz';

			// Can't do this the easy way..
			const tgz = evt.target.result;
			const inf = pako.inflate(tgz);
			const ab = inf.buffer;
			const ut = await untar(ab);
			processTarGzFile(ut);
		}
		// 425a6839 == Tar.Bz2
		else
		{
			console.debug('Unsure what file type we where handed', header);
			throw new Error ('Invalid usingArchive');
		}
	};

	// Send the received file data to our file reader.
	await reader.readAsArrayBuffer(evt.target.files[0]);
}

/* Handles receiving a file from a url.  Due to browser security, needs to be local or have appropriate COORS headers to allow us to receive it */
async function runParser(lvUrlFile)
{
	console.debug('Loading File', lvUrlFile);

	// Disable the event listners, so we can grab the SMF version data and repopulate data without triggering changes.
	disableVersionChangeListiners();
	await fetchSmfVersions().then(populateSmfVersions);

	if (lvUrlFile.endsWith('tar.gz') || lvUrlFile.endsWith('tgz'))
	{
		usingArchive = 'tgz';
		console.debug('Smells like a tgz');
		await fetch(lvUrlFile).then(res => res.arrayBuffer()) // Download gzipped tar file and get ArrayBuffer
			.then(pako.inflate)			 // Decompress gzip using pako
			.then(arr => arr.buffer)		// Get ArrayBuffer from the Uint8Array pako returns
			.then(untar)					// Untar
			.then(processTarGzFile);
	}
	else if (lvUrlFile.endsWith('zip'))
	{
		usingArchive = 'zip';
		console.debug('Seems to be a zip');

		await new JSZip.external.Promise(function (resolve, reject) {
			JSZipUtils.getBinaryContent(lvUrlFile, function(err, data) {
				if (err) {
					reject(err);
				} else {
					resolve(data);
				}
			});
		}).then(function (data) {
			return JSZip.loadAsync(data);
		}).then(await processZipFile).catch(function (e) {
			console.debug('Error!', e);
			document.getElementById('errorContainer').removeAttribute('hidden');
			document.getElementById('errorContainer').innerHTML = e;
		});
	}
	else
		throw new Error ('Invalid usingArchive');
}

/* Adds our event listner to changing the SMF version */
function addVersionChangeListiners()
{
	console.debug('Enable Version Change Listner');
	document.getElementById('smfVersions').addEventListener('change', changeSmfVersion);
}

/* Disables our event listner to change the SMF Version */
function disableVersionChangeListiners()
{
	console.debug('Disable Version Change Listner');
	document.getElementById('smfVersions').removeEventListener('change', changeSmfVersion);
}

/* Handles all logic we need to do in order to procoess the zip file */
async function processZipFile(zip)
{
	console.debug('Processing ZIP');
	archiveData = zip;
	await processFile();
}

/* Handles all logic we need to do in order to procoess the tar.gz file */
async function processTarGzFile(tgz)
{
	console.debug('Processing TGZ');
	archiveData = tgz;
	await processFile();
}

/* This processes the file, we have generic handlers and some functions will handle treating the zip/tar data differently as needed*/
async function processFile()
{
	// This extracts the info file from the root.  If its in a sub folder, it won't find it.
	infoData = await fetchFileFromArchive('package-info.xml');

	// Attempt to parse the info file as valid xml data.
	console.debug('Attempting to parse package-info.xml into XML Object');
	parsedInfo = parseXml(infoData);
	if (typeof parsedInfo === 'undefined')
		throw new Error ('Unable to parse package-info.xml');

	// Try to find our package name
	console.debug('Attempting to find Customization Name');
	packageName = parsedInfo.getElementsByTagName('name')[0]?.innerHTML;

	// Can't find it, do not go any further.
	if (typeof packageName === 'undefined')
		throw new Error ('Unable to find Customization Name');

	// Set up showing some information about this.
	setPackageName(packageName);
	showParserContainer();

	// Ensure our event listners are disable, change our version drop down to list the versions we match better.
	console.debug('Locating possible versions');
	disableVersionChangeListiners();
	let possibleInstalls = parsedInfo.getElementsByTagName('install');
	for(let i = 0; i < possibleInstalls.length; i++)
		processInstallXml(possibleInstalls[i]);

	// We can listen for events now.
	addVersionChangeListiners();

	// Trigger a version change, which should have the best and newest match for this package now.
	document.getElementById('smfVersions').dispatchEvent(new Event('change'));
}

/* This function retrieves a file from the archive for use later */
async function fetchFileFromArchive(fileName)
{
	let fileData = null;

	if (usingArchive == 'zip')
	{
		// The zip handler treats them as objects, but we need to ensure we can find files regardless of case, so we find the match, to find the real file name.
		let match = archiveData.files[Object.keys(archiveData.files).find(key => key.toLowerCase() === fileName.toLowerCase())];

		// We can't continue without the file.
		if (match == undefined || match == null)
			throw new Error('Unable to find ' + fileName);

		// Now extract the info-file contents.
		realFileName = match.name;
		fileData = await archiveData.file(realFileName).async('string');

		return fileData;
	}
	else if (usingArchive == 'tgz')
	{
		// The tar handler treats them as arrays.  But we also need to handle case sensitivity, so find the index.
		let index = archiveData.map(function(e) { return e.name.toLowerCase(); }).indexOf(fileName.toLowerCase()) ?? -1;

		// We can't continue without the file.
		if (index < 0 || !archiveData[index])
			throw new Error('Unable to find ' + fileName);

		// Get our file data from the index we have.
		let UseBlob = false;
		try {
			fileData = await archiveData[index].readAsString();
		}
		catch (err) {
			if (err.message.indexOf('Maximum call stack size exceeded') > -1)
				UseBlob = true;
			else
				throw err;
		}

		// Sometimes we need to use blob because to get around maximum call stack size exceeded
		if (UseBlob == true && fileData == null)
		{
			const fileBlob = await archiveData[index].blob;
			fileData = await new Response(fileBlob).text();
		}

		return fileData;
	}
	else
		throw new Error ('Invalid usingArchive');
}

/* Fetch SMF version data from a API, store it in localStage */
async function fetchSmfVersions()
{
	let smfVersions = [];
	const now = new Date();

	// Try the cache.
	const cachedVersions = localStorage.getItem('smfVersions');
	if (cachedVersions)
	{
		const item = JSON.parse(cachedVersions);

		// Cache is valid.
		if (item.expiry && now.getTime() < item.expiry)
			return item.value;
	}

	console.debug('Fetching SMF Version API');
	try
	{
		await fetch(SmfVersionApiURL, {
			method:'GET',
			headers: {
				'Content-Type': 'application/json'
			},
		})
			.then(res => res.json())
			.then(out => smfVersions = out)
			.catch(err => { throw err });

		// We have not always been semantic versioning, lets clean it up.
		smfVersions.data.forEach(function(data, index, theArray) {
			theArray[index] = semanticVersion(data);
		});

		const item = {
			value: smfVersions,
			expiry: now.getTime() + 100 * 60 * 60,
		}
		localStorage.setItem('smfVersions', JSON.stringify(item))

		return smfVersions;
	}
	catch
	{
		console.debug('Failed to fetch SMF Versions, attempt fallback');

		const cachedVersions = localStorage.getItem('smfVersions');
		const item = JSON.parse(cachedVersions) ?? null;

		// We failed, but do we have a cache to fall back on?
		if (item != null && item.value != null)
			return item.value;
		else
			throw new Error('Unable to fetch SMF Versions');
	}
}

/* Populate the SMF Versions drop down */
function populateSmfVersions(json)
{
	console.debug('Populating SMF Versions');

	if (typeof json === 'undefined' || typeof json.data === 'undefined')
		throw new Error ('Missing SMF Versions');

	disableVersionChangeListiners();

	// Clean out the existing data, this is supposed to be faster than innterHTML = '';
	let pf = document.getElementById('preferedVersions');
	if (pf && pf.hasChildNodes)
		while (pf.firstChild)
			pf.removeChild(pf.firstChild);
	let ot = document.getElementById('otherVersions');
	if (ot && ot.hasChildNodes)
		while (ot.firstChild)
			ot.removeChild(ot.firstChild);

	// Sort, reverse and then put into the DDL
	json.data.sort(window.compareVersions.compareVersions).reverse().forEach(function (ver) {
		var option = document.createElement("option");
		option.text = ver;
		option.value = ver;

		ot.appendChild(option);
	});

	addVersionChangeListiners();
}

/* Wrapper for DomParser to return a XML object */
function parseXml(xmlString)
{
	const parser = new DOMParser();
	const xmlDoc = parser.parseFromString(xmlString,'text/xml');

	if (!xmlDoc)
		throw new Error('Unable to Parse XML data');
	return xmlDoc;
}

/* Show the Parser container */
function showParserContainer()
{
	console.debug('Showing the Parser Container');
	document.getElementById('instructionsContainer').removeAttribute('hidden');
	document.getElementById('smfVersions').removeAttribute('hidden');
}

/* Hide the Parser container */
function hideParserContainer()
{
	console.debug('Hidding the Parser Container');
	document.getElementById('instructionsContainer').setAttribute('hidden');
	document.getElementById('smfVersions').setAttribute('hidden');
}

/* Set our page title with the package name */
function setPackageName(packageName)
{
	console.debug('Set the Package Name', packageName);
	document.getElementById('packageName').innerHTML = packageName;
}

/* Processes the install XML data for the "for" attributes, finds the SMF versions supported, updating our prefered versions */
function processInstallXml(xml)
{
	console.debug('Processing Install XML data');
	let setDefault = true;

	// Find a "for".  It is valid to not have a for, as it implies it installs for any version of SMF.
	const forVersions = xml.getAttribute('for');
	if (forVersions)
	{
		// The list is comma separated.
		const versions = forVersions.split(',');
		for (let j = 0; j < versions.length; j++)
		{
			// Fidn the first and last version in the string provided, even if just a single version.
			vr = findVersionRangeFromFor(versions[j]);

			// The newest match will be moved to Prefered versions.
			setPreferedVersion(vr.end, vr.start);

			// If we have not set a default, do it now.
			if (setDefault)
			{
				console.debug('Setting a default version');
				const cn = document.getElementById('preferedVersions').getElementsByTagName('option')[0]?.value ?? null;

				if (cn != null)
					document.getElementById('smfVersions').value = cn;
				setDefault = false;
			}
		}
	}
}

/* Given a version string from a install for="", we find the newest and oldest verison in that range */
function findVersionRangeFromFor(forString)
{
	// No version, lets simplify it and say it matches anything.
	if (forString == '' || forString == null)
	{
		console.debug('No version specified from for');
		return {
			'start': '0.0.0-Alpha1',
			'end': '99.99.99'
		};
	}

	// Strip off 'SMF';
	forString = forString.replace('SMF', '');

	// No - nor *, must just be a single version, no other wildcards are supported.
	if (forString.indexOf('-') == -1 && forString.indexOf('*') == -1)
	{
		console.debug('No Range, single version', forString);
		return {
			'start': semanticVersion(forString),
			'end': semanticVersion(forString)
		};
	}

	// If we have a * we need to split it up.  "SMF 2.1.*"
	if (forString.indexOf('*') > -1)
		forString = forString.replace('.*', '.0') + '-' + forString.replace('.*', '.99');

	// Now we have for sure a range, split it.  "2.1.3-2.1.52"
	const es = forString.split('-');

	// SMF consideres '2.0' to be '2.0.0-Alpha1' not '2.0.0'
	if (es[0].trim().match(/^\d\.\d$/, 'g'))
		es[0] = es[0].trim().replace(/^(\d)\.(\d)$/, '$1.$2.0-Alpha1', 'g');

	console.debug('Finding Version Range For', forString, es);
	return {
		'start': semanticVersion(es[0].trim()),
		'end': semanticVersion(es[1].trim())
	};
}

/* Given a newest and oldest version, try to find the best match and move only that one to the prefered versions */
function setPreferedVersion(end, start)
{
	console.debug('Setting Prefered Versions', end, start);
	const pf = document.getElementById('preferedVersions');
	const ot = document.getElementById('otherVersions');
	const otOpts = ot.getElementsByTagName('option');

	for(let i = 0; i < otOpts.length; i++)
	{
		if (compareVersions.compare(otOpts[i].value, start, '>=') && compareVersions.compare(otOpts[i].value, end, '<='))
		{
			pf.appendChild(otOpts[i]);

			// Because we moved the node, move the counter back one.  This is only really needed if we want to multi-match.
			--i;

			break;
		}
	}
}

/* When we change the SMF Version DDL, we trigger redoing parser data.  This is also triggered when the package is first uploaded */
async function changeSmfVersion(e)
{
	let installXml = null;
	const selectedVersion = document.getElementById('smfVersions').value;

	console.debug('Changing SMF Version', selectedVersion);

	const possibleInstalls = parsedInfo.getElementsByTagName('install');
	for (let i = 0; i < possibleInstalls.length; i++)
	{
		const forVersions = possibleInstalls[i].getAttribute('for');

		const versions = forVersions.split(',');
		for (let j = 0; j < versions.length; j++)
		{
			vr = findVersionRangeFromFor(versions[j]);

			if (compareVersions.compare(selectedVersion, vr.start, '>=') && compareVersions.compare(selectedVersion, vr.end, '<='))
			{
				installXml = i;
				break;
			}
		}

		if (installXml != null)
			break;
	}

	if (installXml == null)
		throw new Error ('No valid Install instructions for this SMF version found');

	// Set the install xml we want to use and parse it.
	const seletedInstallNode = possibleInstalls[installXml];
	await parseInstallNode(seletedInstallNode);
}

/* Process a install node for actions to be taken */
async function parseInstallNode(installNode)
{
	if (!installNode || !installNode.children)
		throw new Error ('Invalid Install instructions');

	// Clear this out incase it wasn't.
	instructions = [];

	for (let i = 0; i < installNode.children.length; i++) {
		let thisNode = installNode.children[i];

		switch (thisNode.tagName)
		{
			case 'readme':
				if (!instructions['readme'])
					instructions['readme'] = [];
				instructions['readme'].push(await parseReadmeNode(thisNode));
				break;

			// Code and database are essentially the same, with the exception of database operations during package install are tracked.
			case 'code':
			case 'database':
				if (!instructions['code'])
					instructions['code'] = [];
				instructions['code'].push(await parseCodeNode(thisNode));
				break;

			case 'create-dir':
			case 'create-file':
			case 'require-dir':
			case 'require-file':
			case 'move-dir':
			case 'move-file':
			case 'remove-dir':
			case 'remove-file':
				if (!instructions['fileop'])
					instructions['fileop'] = [];
				instructions['fileop'].push(await parseFileOpNode(thisNode, thisNode.tagName));
				break;

			case 'hook':
				if (!instructions['hook'])
					instructions['hook'] = [];
				instructions['hook'].push(await parseHookNode(thisNode));
				break;

			case 'credits':
				if (!instructions['credits'])
					instructions['credits'] = [];
				instructions['credits'].push(await parseCreditNode(thisNode));
				break;

			case 'modification':
				if (!instructions['modification'])
					instructions['modification'] = [];
				instructions['modification'].push(await parseModificationNode(thisNode));
				break;
		}
	}

	// We have build all the data, render it on the page.
	buildPage();
}

/* Takes a <readme> node and parses out the data */
async function parseReadmeNode(node)
{
	let lang = 'english';
	let text = '';

	if (node.getAttribute('lang'))
		lang = node.getAttribute('lang');

	if (node.getAttribute('type') && node.getAttribute('type') == 'inline')
		text = node.innerHTML;
	// We have a file.
	else
	{
		const fileName = node.innerHTML.trim();
		text = await fetchFileFromArchive(fileName);
	}

	if (node.getAttribute('parsebbc') && node.getAttribute('parsebbc') === 'true')
		text = bbcParser.parse(text);

	return {
		lang: lang,
		text: text
	};
}

/* Takes a <code> node and parses out the data */
async function parseCodeNode(node)
{
	let code = '';
	let fileName = '';

	if (node.getAttribute('type') && node.getAttribute('type') == 'inline')
	{
		fileName = 'inlineCode.php';
		code = node.innerHTML;
	}
	// We have a file.
	else
	{
		fileName = node.innerHTML.trim();
		code = await fetchFileFromArchive(fileName);
	}

	return {
		fileName: fileName,
		code: code
	};
}

/* Takes various file based operation nodes and parses out the data */
async function parseFileOpNode(node, op)
{
	return {
		type: op,
		name: node.getAttribute('name') ?? '',
		destination: node.getAttribute('destination') ?? '',
		from: node.getAttribute('from') ?? ''
	};
}

/* Takes a <hook> node and parses out the data */
async function parseHookNode(node)
{
	return {
		func: node.getAttribute('function'),
		name: node.getAttribute('hook') ?? node.innerHTML,
		include_file: node.getAttribute('file'),
		reverse: node.getAttribute('reverse') && node.getAttribute('reverse') == 'true' ? true : false,
		object: node.getAttribute('object') && node.getAttribute('object') == 'true' ? true : false
	};
}

/* Takes a <credit> node and parses out the data */
async function parseCreditNode(node)
{
	return {
		title: node.innerHTML,
		url: node.getAttribute('url') ?? '',
		license: node.getAttribute('license') ?? '',
		licenseurl: node.getAttribute('licenseurl') ?? '',
		copyright: node.getAttribute('copyright') ?? '',
		version: parsedInfo.getElementsByTagName('version')[0]?.innerHTML ?? ''
	};
}

/* Takes a <modification> node and parses out the data */
async function parseModificationNode(node)
{
	let edits = null;
	let reverse = false;
	const fileName = node.innerHTML.trim();
	fileContents = await fetchFileFromArchive(fileName);

	if (node.getAttribute('reverse') && node.getAttribute('reverse') == 'true')
		reverse = true;

	// Only other format supported is boardmod.
	if (node.getAttribute('format') && node.getAttribute('format') == 'boardmod')
	{
		console.debug('BoardMod detected');
		edits = parseBoardBoard(fileContents);
	}
	else
	{
		console.debug('Modification XML detected');
		edits = parseModificationXML(fileContents);
	}

	return {
		edits: edits,
		reverse: reverse,
	};
}

/* BoardMod is not used anymore, but its still supported */
function parseBoardBoard(data)
{
	let edits = [];
	let file = '';
	let search = '';
	let position = '';
	let add = '';

	// Match our board mod data.
	const matches = data.matchAll(/<(edit file|file|search|search for|add|add after|replace|add before|add above|above|before|below)>\n?(.*?)\n?<\/\1>/gims);
	for (const match of matches)
	{
		// Update our file data.
		if (match[1] == 'file' || match[1] == 'edit file')
		{
			file = match[2];
		}
		// Found a search data.
		else if (file != '' && (match[1] == 'search' || match[1] == 'search for'))
		{
			search = match[2];
		}
		// If we have file and search data, we can now match for the add/edit data.
		else if (file != '' && search != '')
		{
			// If its 'add before', 'before', 'add above' or 'above' means the add/edit code should come after.
			if (match[1].includes('before') || match[1].includes('above'))
				position = 'after';
			// If its 'add after', or 'below', the add/edit code should come before.
			else if (match[1].includes('after') || match[1].includes('below'))
				position = 'before';
			// If its 'add', 'replace', we are replacing the code.
			else
				position = 'replace';

			edits.push({
				file: file,
				search: search,
				position: position,
				add: match[2],
				fileSkipOnError: false,
				opSkipOnError: false
			});

			// Reset our search.
			search = '';
		}
	}

	return edits;
}

/* Parse Modification XML data */
function parseModificationXML(data)
{
	let edits = [];
	let file = '';
	let search = '';
	let position = '';
	let add = '';
	let fileSkipOnError = false;
	let opSkipOnError = false;
	let opUseRegex = false;
	let opSearchEOF = false;

	const parser = new DOMParser();
	const xmlDoc = parser.parseFromString(data,'text/xml');

	if (!xmlDoc)
		throw new Error('Unable to Parse XML data');

	let fileEdits = xmlDoc.getElementsByTagName('file');
	for (let i = 0; i < fileEdits.length; i++)
	{
		// Firstly find our file information.
		file = fileEdits[i].getAttribute('name');

		// When the file has error="ignore" or error="skip", we are able to skip any errors locating changes for the entire file.
		fileSkipOnError = (fileEdits[i].getAttribute('error') == 'ignore' || fileEdits[i].getAttribute('error') == 'skip');

		// No edits? Skip.
		if (fileEdits[i].getElementsByTagName('operation').length == 0)
			continue;

		let ops = fileEdits[i].getElementsByTagName('operation');
		for (let j = 0; j < ops.length; j++)
		{
			position = ops[j].getElementsByTagName('search')[0]?.getAttribute('position');

			// When the operation has error="ignore" or error="skip", we are able to skip any errors locating changes for just this operation.
			opSkipOnError = (ops[j].getAttribute('error') == 'ignore' || ops[j].getAttribute('error') == 'skip');

			// Regex is supported for operations.  However it is not reversed.
			opUseRegex = ops[j].getElementsByTagName('search')[0]?.getAttribute('regexp') == 'true';
			add = HtmlEncode(ops[j].getElementsByTagName('add')[0]?.childNodes[0].data);

			// If the position is end, pretend its looking for the PHP closing tag to make it easier'
			search = position == 'end' ? '?' + '>' : HtmlEncode(ops[j].getElementsByTagName('search')[0]?.childNodes[0].data);
			opSearchEOF = position == 'end' ? true : false;

			/* We add a edit only if
				1. Any of the following conditions. (OR)
					a. search string is not empty
					b. We are looking for the end of the file
				2. We have a valid position.
				3. We have a non empty add/edit string.
			*/
			if ((search.length > 0 || opSearchEOF) && position.length > 0 && add.length > 0)
				edits.push({
				file: file,
				search: search,
				position: position,
				add: add,
				fileSkipOnError: fileSkipOnError,
				opSkipOnError: opSkipOnError,
				opUseRegex: opUseRegex,
				opSearchEOF : opSearchEOF
			});
		}
	}

	return edits;
}

/* Take all of the data we have built and build HTML output */
function buildPage()
{
	console.debug('Building Page');

	// Clean it out first, this is faster than innerHTML = '' according to the internet.
	let ic = document.getElementById('instructionsContainer');
	if (ic && ic.hasChildNodes)
		while (ic.firstChild)
			ic.removeChild(ic.firstChild);

	/*
		The Order of Operations on the output are:
			Readme
			Modifications
			Hooks
			Code/Database
			File Operations
			Credits
		*/

	if (instructions.readme != null && instructions.readme.length > 0)
		buildPageReadme();

	if (instructions.modification != null && instructions.modification.length > 0)
		buildPageModifications();

	if (instructions.hook != null && instructions.hook.length > 0)
		buildPageHooks();

	if (instructions.code != null && instructions.code.length > 0)
		buildPageCode();

	if (instructions.fileop != null && instructions.fileop.length > 0)
		buildPageFileOperations();

	if (instructions.credits != null && instructions.credits.length > 0)
		buildPageCredits();

	// Leave this debugging info here, useful to know and call when working on it.
	//console.debug('instructions', instructions, instructions.modification[0].edits);
}

/* Prepare output for a readme section */
function buildPageReadme()
{
	const langs = instructions.readme.map(function(e) {return e.lang;});
	const lang = 'english';

	const index = instructions.readme.map(function(e) { return e.lang.toLowerCase(); }).indexOf(lang.toLowerCase()) ?? -1;
	const thisReadme = instructions.readme[index];

	let template = document.getElementById('templateReadme').cloneNode(true);
	template.removeAttribute('hidden');
	template.innerHTML = template.innerHTML.replace('{TITLE}', txt['title_readme']).replace('{CONTENT}', thisReadme.text);

	document.getElementById('instructionsContainer').appendChild(template);
}

/* Prepare output for a modification section */
function buildPageModifications()
{
	let templateTitle = document.getElementById('templateOperationsTitle').cloneNode(true);
	let fileName = '';
	let templateFileTitle = null;
	let template = null;

	// Setup the title.
	templateTitle.removeAttribute('id');
	templateTitle.removeAttribute('hidden');
	templateTitle.innerHTML = templateTitle.innerHTML.replace('{TITLE}', txt['title_operations']);
	document.getElementById('instructionsContainer').appendChild(templateTitle);

	// Work through all modifications we do, which could be from multiple modification files.
	for (let i = 0; i < instructions.modification.length; i++)
	{
		const thisOperation = instructions.modification[i];

		// Loop through all edits we do.
		for (let j = 0; j < thisOperation.edits.length; j++)
		{
			const thisEdit = thisOperation.edits[j];

			// Set a new file name.
			if (fileName != thisEdit.file)
			{
				fileName = thisEdit.file;
				templateFileTitle = document.getElementById('templateOperationsTitle').cloneNode(true);
				templateFileTitle.removeAttribute('id');
				templateFileTitle.removeAttribute('hidden');
				templateFileTitle.innerHTML = templateFileTitle.innerHTML.replace('{TITLE}', fileName);
				document.getElementById('instructionsContainer').appendChild(templateFileTitle);

				if (thisEdit.fileSkipOnError == true)
				{
					templateFileTitle.querySelector('.alert').innerHTML = txt['file_edit_skip_error'];
					templateFileTitle.querySelector('.alert').removeAttribute('hidden');
				}
			}

			// Start working on our template.
			template = document.getElementById('templateOperations').cloneNode(true);
			template.removeAttribute('id');
			template.removeAttribute('hidden');

			// The search section.
			template.querySelector('.searchContainer h5').innerHTML = thisEdit.position == 'end' ? txt['operation_end'] : txt['operation_search'];

			// If we are going in reverse, flip some logic around.
			if (thisOperation.reverse != null && thisOperation.reverse == true)
			{
				if (thisEdit.position == 'before')
					thisEdit.position = 'after';
				else if (thisEdit.position == 'after')
					thisEdit.position = 'before';

				template.querySelector('.addContainer h5').innerHTML = txt['operation_' + thisEdit.position];
				template.querySelector('.operationSearch pre').innerHTML = thisEdit.add;
				template.querySelector('.operationAdd pre').innerHTML = thisEdit.search;
			}
			else
			{
				template.querySelector('.addContainer h5').innerHTML = thisEdit.position == 'end' ? txt['operation_before'] : txt['operation_' + thisEdit.position];
				template.querySelector('.operationSearch pre').innerHTML = thisEdit.search;
				template.querySelector('.operationAdd pre').innerHTML = thisEdit.add;
			}

			// If we can skip this operation, add a notice.
			if (thisEdit.opSkipOnError == true)
			{
				template.querySelector('.alert.alert-warning').innerHTML = txt['edit_skip_error'];
				template.querySelector('.alert.alert-warning').removeAttribute('hidden');
			}

			// If this is a regex search, they will need something better than notepad.
			if (thisEdit.opUseRegex == true)
			{
				template.querySelector('.alert.alert-info').innerHTML = txt['edit_uses_regex'];
				template.querySelector('.alert.alert-info').removeAttribute('hidden');
			}

			document.getElementById('instructionsContainer').appendChild(template);
		}
	}

	// Make it so we can click the clipboard icon and copy the data.
	document.querySelectorAll('.operationSearchCopy,.operationAddCopy').forEach(el => {
		el.addEventListener('click', function(evt) {
			const CodeArea = this.parentNode.nextSibling.nextSibling.querySelector('pre');
			const CurSelection = window.getSelection();

			// Webkit based browsers support setBaseAndExtent.
			if (CurSelection.setBaseAndExtent)
			{
				CurSelection.setBaseAndExtent(CodeArea, 0, CodeArea, CodeArea.childNodes.length);
			}
			// Firefox and others.
			else
			{
				const curRange = document.createRange();
				curRange.selectNodeContents(CodeArea);
				CurSelection.removeAllRanges();
				CurSelection.addRange(curRange);
			}

			// Try to execute the copy command.  Give up silently if it doesn't.
			try {
				document.execCommand('copy');
			} catch (err) {
			}
		});
	});
}

/* Prepare output for a hooks section */
function buildPageHooks()
{
	let template = document.getElementById('templateHooks').cloneNode(true);
	template.removeAttribute('hidden');

	// Loop through all data and just put it into a nice table.
	for (let i = 0; i < instructions.hook.length; i++)
	{
		const thisHook = instructions.hook[i];

		let newTR = document.createElement('tr');
		let newTD = document.createElement('td');
		newTR.appendChild(newTD);

		if (thisHook.name == 'integrate_pre_include')
			newTD.innerHTML = txt['hook_pre_include'].format(thisHook.func);
		else
			newTD.innerHTML = txt['hook_add'].format(thisHook.func, thisHook.name);

		template.querySelector('table tbody').appendChild(newTR);
	}

	template.innerHTML = template.innerHTML.replace('{TITLE}', txt['title_hook']);
	document.getElementById('instructionsContainer').appendChild(template);
}

/* Prepare output for a code section */
function buildPageCode()
{
	let template = document.getElementById('templateCode').cloneNode(true);
	template.removeAttribute('hidden');

	// Loop through all data and just put it into a nice table.
	for (let i = 0; i < instructions.code.length; i++)
	{
		const thisCode = instructions.code[i];

		let newTR = document.createElement('tr');
		let newTD = document.createElement('td');
		newTR.appendChild(newTD);

		newTD.innerHTML = thisCode.fileName;

		// Build a container and link to download the code.
		let downloadTD = document.createElement('td');
		newTR.appendChild(downloadTD);
		downloadAnchor = document.createElement('a');
		downloadAnchor.innerHTML = txt['download'];
		downloadAnchor.download = thisCode.fileName;

		const file = new Blob([Uint8Array.from(thisCode.code, c => c.charCodeAt(0))])
		const url = URL.createObjectURL(file)
		downloadAnchor.href = url;

		downloadTD.appendChild(downloadAnchor);

		template.querySelector('table tbody').appendChild(newTR);
	}

	template.innerHTML = template.innerHTML.replace('{TITLE}', txt['title_code']);
	document.getElementById('instructionsContainer').appendChild(template);
}

/* Prepare output for file operations section */
function buildPageFileOperations()
{
	let template = document.getElementById('templateFileOperations').cloneNode(true);
	template.removeAttribute('hidden');

	// Loop through all data and just put it into a nice table.
	for (let i = 0; i < instructions.fileop.length; i++)
	{
		const thisHook = instructions.fileop[i];

		let newTR = document.createElement('tr');
		let newTD = document.createElement('td');
		newTR.appendChild(newTD);

		let msg = txt['file_operation_' + thisHook.type];
		if (thisHook.name != null && thisHook.destination != null)
			msg = msg.format(thisHook.name, formatPath(thisHook.destination));
		else if (thisHook.name != null)
			msg = msg.format(thisHook.name);

		newTD.innerHTML = msg;
		template.querySelector('table tbody').appendChild(newTR);
	}

	template.innerHTML = template.innerHTML.replace('{TITLE}', txt['title_fileop']);
	document.getElementById('instructionsContainer').appendChild(template);
}

/* Prepare output for credits section, SMF would normally insert this into a table to track. */
function buildPageCredits()
{
	let template = document.getElementById('templateCredits').cloneNode(true);
	template.removeAttribute('hidden');

	// Loop through all data and just put it into a nice table.
	for (let i = 0; i < instructions.credits.length; i++)
	{
		const thisCredit = instructions.credits[i];

		let newTR = document.createElement('tr');
		let newTD = document.createElement('td');
		newTR.appendChild(newTD);

		let credit = '';
		if (thisCredit.url != null)
			credit = '<a href=' + thisCredit.url + '" rel="noopener">' + (thisCredit.title ?? packageName) + ': ' + txt['credits_version'] + ' ' + thisCredit.version + '</a>';
		else
			credit = (thisCredit.title ?? packageName) + ': ' + txt['credits_version'] + ' ' + thisCredit.version;

		if (thisCredit.licenseurl != null)
			credit += ' | ' + txt['credits_license'] + '<a href="' + thisCredit.licenseurl + '">' + thisCredit.license + '</a>';
		else
			credit += ' | ' + txt['credits_license'] + thisCredit.license;

		newTD.innerHTML = credit;
		template.querySelector('table tbody').appendChild(newTR);
	}

	template.innerHTML = template.innerHTML.replace('{TITLE}', txt['title_credits']);
	document.getElementById('instructionsContainer').appendChild(template);
}

/* SMF hasn't been consistent nor always following semantic versioning.  So do some cleanup to help with issues parsing versions */
function semanticVersion(version)
{
	// Straight forward simple replacements.
	const replacements = [
		{k: ' Security Patch', v:'.1'} // 2.0 RC4 Security Patch
	];

	// Some regular expression replacements.
	const pregReplacments = [
		// 2.0 => 2.0.0
		{k: /^(\d)\.(\d)$/, v:'$1.$2.0'},

		// 2.0 RC-1 => 2.0.0-RC1
		{k: /^(\d)\.(\d) RC(\s-)?(\d)$/, v:'$1.$2.0-RC$4'},

		// 2.0 RC 2-1 => 2.0.0-RC2.1
		{k: /^(\d)\.(\d) RC(\s-)?(\d)[\.|-](\d)$/, v:'$1.$2.0-RC$4.$5'},

		// 2.1 Beta 3 Public => 2.1.0-Beta3
		{k: /^(\d)\.(\d) Beta\s?(\d)( Public)?$/, v:'$1.$2.0-Beta$3'},

		// 2.1 Beta 2.1 => 2.1.0-Beta2.1
		{k: /^(\d)\.(\d) Beta\s?(\d)[\.|-](\d)( Public)?$/, v:'$1.$2.0-Beta$3.$4'}
	];

	// Do the simple ones first.
	version = replacements.reduce((rt,cv,ci) => rt.replace(cv['k'],cv['v']), version);

	// Do our regular expressions.
	version = pregReplacments.reduce(function (rt,cv,ci) {
		let re = new RegExp(cv['k'], 'gi');
		return rt.replace(re, cv['v']);
	}, version);

	return version;
}

/* Take a string and replace some variables with something more logical to understand */
function formatPath(path)
{
	const Replacements = [
		{k:'\\\\', v: '/'},
		{k:'$boarddir', v:'.'},
		{k:'$sourcedir', v:'./Sources'},
		{k:'$avatardir', v:'./avatars'},
		{k:'$avatars_dir', v:'./avatars'},
		{k:'$themedir', v:'./Themes/default'},
		{k:'$imagesdir', v:'./Themes/default/images'},
		{k:'$themes_dir', v:'./Themes'},
		{k:'$languagedir', v:'./Themes/default/languages'},
		{k:'$languages_dir', v:'./Themes/default/languages'},
		{k:'$smileysdir', v:'./Smileys'},
		{k:'$smileys_dir', v:'./Smileys'},
	];

	return Replacements.reduce((rt,cv,ci) => rt.replace(cv['k'],cv['v']), path);
}

/* The simple JS BBC parser needs some help. */
async function setBBCodes()
{
	bbcParser.add('\\[size=large\\]', '<span style="font-size: 120%;">');
	bbcParser.add('\\[\\/size\\]', '</span>');
	bbcParser.add('\n', '<br>');
	bbcParser.add('\\[code\\](.+?)\\[\\/code\\]', '<pre>$1</pre>');
}

/* Encode HTML entities made easy */
function HtmlEncode(s)
{
	let el = document.createElement('div');
	el.innerText = el.textContent = s;
	return el.innerHTML;
}