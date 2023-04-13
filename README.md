This tool parses SMF Packages to show you the instructions that will be peformed.

This tool is built entirely in javascript and requires no server side utilities.

I built this as an expierement to see if I could parse packages entirely in the borwser, which is succesful.  However due to CORS, its not possible to fetch remote files.  You can fetch files using the FileName javascript variable.  They must exist on the same domain, or the remote domain must allows CORS/XHR requests.