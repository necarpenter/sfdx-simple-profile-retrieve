// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as child from 'child_process';
import * as fs from 'fs';
import * as del from 'del';
import { DOMParser,  XMLSerializer, DOMImplementation} from '@xmldom/xmldom';

let workspaceRoot;

const metadataExt = '.profile-meta.xml';
const mainProjectProfilePath = '\\force-app\\main\\default\\profiles\\';
const tempProjectPath = '\\.sfdxspr\\TempRetrieveProject\\';
const tempProjectProfilePath = tempProjectPath+'force-app\\main\\default\\profiles\\';
const parser = new DOMParser();

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand('sfdx-simple-profile-retrieve.getPerms', async (fileURI: string | null) => {
		let fieldName = '';
		console.log('fileURI: '+fileURI);
		if(fileURI){
			console.log('fieldName before');
			fieldName = getFieldName(fileURI);
			console.log('fieldName:'+fieldName);
		}else{
			const opts = {
				ignoreFocusOut : true,
				placeHolder : 'e.g. Lead.Lead_Type__c',
				prompt: 'Enter the Object name with the full field api name.',
		
			};
			fieldName = await vscode.window.showInputBox(opts);
		}
		
		console.log('fieldName found:'+fieldName);
		await getWorkspaceRoot();
		//const userInput = 'Lead.Lead_Type__c';
		if(fieldName){
			// setup enviroment
			await createTempBranch();
			await setDefaultUsername();
			await getFieldPerms(fieldName);

			// find changes and update
			await doDiffs(fieldName);
			deleteTempProject();
		} 
	});

	context.subscriptions.push(disposable);
}
const profileType = 'Profile';
const fieldTypePrefix = 'CustomField:';
async function getFieldPerms(fieldFullName : string){
	let requestTypes = profileType + ',' + fieldTypePrefix + fieldFullName;
	let cmd = 'sfdx force:source:retrieve -m "'+requestTypes+'"';
	await execCmd(cmd, 'Retrieving Metadata...',  workspaceRoot + tempProjectPath);

}
function getFieldName(fileURI: string) : string{
	let uriArr = fileURI.split('\\');
	console.log('uriArr: '+ uriArr);
	let objNameStr = '';
	let index = 0;
	while(objNameStr === '' && index < uriArr.length){
		if(uriArr[index] === 'object'){
			objNameStr = uriArr[index+1];
		}
		
		console.log('uriArr[index] : '+ uriArr[index] );
		index++;
	}
	console.log('objNameStr: '+ objNameStr);

	
	let fieldFile = fs.readFileSync(fileURI,'utf8');
	let fieldDoc = parser.parseFromString(fieldFile, "application/xml");
	let fieldName = fieldDoc.getElementsByTagName('fullName')[0].getElementsByTagName('CustomField')[0].nodeValue;
	console.log('fieldName: '+ fieldName);
	
	return objNameStr + '.' + fieldName;

}
async function createTempBranch(){
	let cmd = 'sfdx force:project:create --projectname TempRetrieveProject -d .sfdxspr';
	await execCmd(cmd, 'Starting up extension...', workspaceRoot);
}

async function setDefaultUsername(){
	let cmd = 'sfdx force:alias:list --json';
	let aliasList = await execCmd(cmd, 'Starting up extension...', workspaceRoot);
	let username = JSON.parse(aliasList).result[0].alias;

	let cmd2 = 'sfdx config:set defaultusername='+username;
	
	await execCmd(cmd2, 'Starting up extension: setting username...', workspaceRoot + tempProjectPath);
}

async function getWorkspaceRoot(){
	if(workspaceRoot){ return workspaceRoot; }

	if(vscode.workspace.workspaceFolders){
		workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
	}else{
		workspaceRoot = await getWorkspaceRootFromUser();
	}
	return workspaceRoot;
}
async function getWorkspaceRootFromUser(){
	const opts = {
		ignoreFocusOut : true,
		prompt: 'Enter the full path to a Workspace that contains a SFDX Project',

	};
	let userInput = await vscode.window.showInputBox(opts);
	return userInput;

}
// TODO: add functionality to show changes and allow approval before writting
function doDiffs(fieldName : string){
	let mainProfileFiles = fs.readdirSync(workspaceRoot + mainProjectProfilePath);
	let tempProfileFiles = fs.readdirSync(workspaceRoot + tempProjectProfilePath);
	let profilesToCompare = [];
	for(let profile of tempProfileFiles){

		if(mainProfileFiles.includes(profile)){
			let profName = profile.replace(metadataExt, '');
			let diffObj = new MetaDataDiffer(profName, fieldName);
			if(diffObj.diffFound()){
				diffObj.saveChanges();
			}
		}
	}
}
function execCmd(cmd : string, progressMsg : string, cwd: string){
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: progressMsg,
		cancellable: true
	}, (progress, token) => {
		token.onCancellationRequested(() => {
			console.log("User canceled the long running operation");
		});

		var p = new Promise<string>(resolve => {
			let foo: child.ChildProcess = child.exec(cmd,{
				maxBuffer: 1024 * 1024 * 6,
				cwd: cwd
			});
			let bufferOutData='';
			foo.stdout.on("data",(dataArg : any)=> {
				
				console.log('dataArg '+dataArg);
				bufferOutData+=dataArg;
			});
			
			/* handling output to stderr has been limited 
			*  since the windows version of sfdx cli dumps progress updates to stderr 
			*  during metadata retrival resulting in false negatives
			*/
			foo.stderr.on("data",(data : any)=> {
				console.error('exec stderr: ' + data);
				//vscode.window.showErrorMessage(data);
				//resolve(bufferOutData);
			});
	
			foo.stdin.on("data",(data : any)=> {
				console.log('stdin: ' + data);
				resolve(bufferOutData);
			});

			foo.on("exit", (code: number, signal: string) => {
				console.log("exited with code "+code);
				if(code === 0){
					resolve(bufferOutData);
				} else{ 
					resolve('Error while executing command exited with code '+code+' '+signal);
				}
			});
		});
		return p;
	});
}

async function deleteTempProject(){
	console.log('Deleting: '+workspaceRoot + tempProjectPath);
	/*
	fs.rmSync(workspaceRoot + '\\TempRetrieveProject', { recursive: true});
	*/
	let dir = workspaceRoot + tempProjectPath;
    try {
        await del(dir, {force: true});

        console.log(`${dir} is deleted!`);
    } catch (err) {
        console.error(`Error while deleting ${dir}.`+err);
    }

}

class MetaDataDiffer{
	/* Parses and diff two different versions of xml metadata files to get changes */
	private metadataType : string;

	private name : string;

	private mainFilePath : string;

	private oldDoc : XMLDocument;
	private newDoc : XMLDocument;

	public oldNode : Element | null;
	public newNode : Element | null;

	public constructor(profileName : string, name : string, metadataType : string = 'fieldPermissions') {
		this.metadataType = metadataType;
		this.name = name;

		this.mainFilePath = workspaceRoot + mainProjectProfilePath+profileName+metadataExt;
		let oldFile = fs.readFileSync(this.mainFilePath,'utf8');
		this.oldDoc = parser.parseFromString(oldFile, "application/xml");

		let newFilePath = workspaceRoot + tempProjectProfilePath+profileName+metadataExt;
		let newFile = fs.readFileSync(newFilePath,'utf8');
		this.newDoc = parser.parseFromString(newFile, "application/xml");
		this.getDiff();
	}

	public diffFound() : Boolean {
		return this.newNode ? true : false;
	}

	public getDiff(){
		this.oldNode = this.getNode(this.oldDoc);
		this.newNode = this.getNode(this.newDoc);
	}

	private getNode(xmlDoc) : Element | null{
		let errorNode = xmlDoc.getElementsByTagName("parsererror");
		let foundNode : Element | null;
		if (errorNode.innerHTML) {
			console.log("error while parsing : "+ new XMLSerializer().serializeToString(errorNode));
		} else {
			let nodes = xmlDoc.getElementsByTagName(this.metadataType);
			if(nodes.length > 0){
				for (let i = 0; i < nodes.length; i++) {
					let node = nodes[i];
					let fieldNodes = node.getElementsByTagName('field');
					if(fieldNodes){
						let field = fieldNodes[0].childNodes[0];
						if(field.nodeValue  === this.name){
							foundNode = node;
						}
					}
			  	}
			}
		}
		return foundNode;
	}
	public saveChanges(){
		let updatedDoc = this.createUpdatedDoc();

		if(updatedDoc.childElementCount > 0){
			let updatedXMLStr = new XMLSerializer().serializeToString(updatedDoc);
			console.log('In Save');
			fs.writeFile(this.mainFilePath, updatedXMLStr, function(err) {
				if (err) {
					return console.error(err);
				}
				console.log("File Saved!");
			});
		}else{
			console.log('No Changes Found');
		}
	}
	private createUpdatedDoc() : XMLDocument{
		let updatedXML = new DOMImplementation().createDocument(null, null, null);
		let profileNode = this.oldDoc.getElementsByTagName('Profile')[0];
		if(this.oldNode){
			profileNode.replaceChild(this.newNode, this.oldNode);
		}else if(this.newNode){
			let linebreak = updatedXML.createTextNode("\t\n");
			let tab = updatedXML.createTextNode("\t");
			profileNode.appendChild(linebreak);
			profileNode.appendChild(tab);
			profileNode.appendChild(this.newNode);
			profileNode.appendChild(linebreak);
		}
		updatedXML.appendChild(profileNode);

		return updatedXML;

	} 
}
// this method is called when your extension is deactivated
export function deactivate() {}
