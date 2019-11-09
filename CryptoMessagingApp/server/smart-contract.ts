import * as NodeApi from './node-api'
import * as MinerImpl from './miner-impl'
import * as HashTools from './hash-tools'
import * as SequenceStorage from './sequence-storage'

interface ContractState {
    uuid: string,
    name: string
    description: string
    contractPublicKey: string
    currentContractIterationId: number
    contractIterations: {
        description: any
    }[]
    instanceData: any
}

interface MachineState {
    contracts: Map<string, ContractState>

    // callId to return value
    returnValues: Map<string, any>
}

type LiveInstance = any

export class SmartContract {
    private contractItemList: SequenceStorage.SequenceStorage
    private registeredChangeListener: SequenceStorage.SequenceChangeListener
    private contractsLiveInstances = new Map<string, Map<string, LiveInstance>>()

    constructor(
        private node: NodeApi.NodeApi,
        private branch: string,
        private namespace: string,
        private miner: MinerImpl.MinerImpl) { }

    initialise() {
        this.contractItemList = new SequenceStorage.SequenceStorage(this.node, this.branch, `${this.namespace}-smart-contract-v1`, this.miner)
        this.contractItemList.initialise()

        this.registeredChangeListener = (sequenceItemsByBlock) => this.updateStatusFromSequence(sequenceItemsByBlock)
        this.contractItemList.addEventListener('change', this.registeredChangeListener)
    }

    terminate() {
        this.contractItemList.removeEventListener(this.registeredChangeListener)
        this.contractItemList.terminate()
        this.node = undefined
    }

    private setLiveInstance(contractUuid: string, iterationId: number, liveInstance: any) {
        if (!this.contractsLiveInstances.has(contractUuid))
            this.contractsLiveInstances.set(contractUuid, new Map())

        this.contractsLiveInstances.get(contractUuid).set("" + iterationId, liveInstance)
    }

    private getLiveInstance(contractUuid: string, iterationId: number) {
        let byIterationId = this.contractsLiveInstances.get(contractUuid)
        let liveInstance = byIterationId && byIterationId.get("" + iterationId)
        if (!liveInstance)
            console.error(`cannot find liveinstance for ${contractUuid} ${iterationId}`)
        return liveInstance
    }

    private stateCache: MachineState = null
    private stateCacheBlockId = null

    private updateStatusFromSequence(sequenceItemsByBlock: { blockId: string; items: SequenceStorage.SequenceItem[] }[]) {
        let state: MachineState

        // start from : 'go reverse from the end until finding something in the cache'
        let startIdx
        for (startIdx = sequenceItemsByBlock.length - 1; startIdx >= 0; startIdx--) {
            if (sequenceItemsByBlock[startIdx].blockId == this.stateCacheBlockId) {
                state = this.stateCache
                startIdx++ // because we start AFTER the last cached block
                break
            }
        }
        //let startIdx = sequenceItemsByBlock.findIndex(v => v.blockId == this.stateCacheBlockId)
        if (startIdx < 0) {
            state = {
                contracts: new Map(),
                returnValues: new Map()
            }
            startIdx = 0
        }

        for (let idx = startIdx; idx < sequenceItemsByBlock.length; idx++) {
            let { blockId, items } = sequenceItemsByBlock[idx]

            if (!items || !items.length) {
                console.log(`empty contract...`)
                continue
            }

            for (let contractItem of items) {
                switch (contractItem['type']) {
                    case 'contract': {
                        let packedDescription = contractItem['data']
                        if (!packedDescription) {
                            console.error(`no packed description found for smart contract, ignoring item ${JSON.stringify(contractItem)}`)
                            continue
                        }

                        if (!HashTools.verifyPackedData(packedDescription)) {
                            console.error(`packed description signature is invalid, ignoring ${JSON.stringify(contractItem)}`)
                            continue
                        }

                        let contractDescription = HashTools.extractPackedDataBody(packedDescription)
                        let contractUuid = contractDescription.uuid

                        // retrieve or create the contract state
                        let contractState: ContractState = null
                        if (state.contracts.has(contractUuid)) {
                            contractState = state.contracts.get(contractUuid)

                            contractState.name = contractDescription.name
                            contractState.description = contractDescription.description
                        }
                        else {
                            contractState = {
                                uuid: contractUuid,
                                contractPublicKey: null,
                                currentContractIterationId: -1,
                                contractIterations: [],
                                instanceData: {},
                                name: contractDescription.name,
                                description: contractDescription.description
                            }

                            state.contracts.set(contractUuid, contractState)
                        }

                        let iterationId = contractState.currentContractIterationId + 1
                        console.log(`Contract ${contractUuid}, iteration ${iterationId}`)

                        if (contractState.contractPublicKey && contractState.contractPublicKey != HashTools.extractPackedDataPublicKey(packedDescription)) {
                            console.error(`iteration does use an incorrect public key`)
                        }

                        contractState.contractIterations[iterationId] = {
                            description: packedDescription
                        }

                        contractState.currentContractIterationId = iterationId
                        if (!contractState.contractPublicKey)
                            contractState.contractPublicKey = HashTools.extractPackedDataPublicKey(packedDescription)

                        let liveInstance = this.createLiveInstance(contractUuid, iterationId, contractDescription.code, state.contracts, state.returnValues)
                        if (!liveInstance) {
                            console.error(`cannot create live instance for contract ${contractDescription.name} ${contractUuid}`)
                            continue
                        }

                        this.setLiveInstance(contractUuid, iterationId, liveInstance)

                        /*console.log(`public key : ${HashTools.extractPackedDataPublicKey(packedDescription).substr(0, 15)}`)
                        console.log(`signature  : ${HashTools.extractPackedDataSignature(packedDescription)}`)
                        console.log(`description:`)
                        console.log(JSON.stringify(HashTools.extractPackedDataBody(packedDescription), null, 4))*/

                        // call init on live instance (if init method is present)
                        // This is the opportunity for the contract to upgrade its data structure : never will it be called again with the previous iteration
                        if ('init' in liveInstance) {
                            try {
                                let callResult = this.callContractInstance(null, 'init', undefined, liveInstance, contractState, state.returnValues, true)
                                if (callResult)
                                    console.log(`initialisation of contract ${contractUuid}@${iterationId} produced result : ${JSON.stringify(callResult)}`)
                            }
                            catch (error) {
                                console.error(`error when initializing contract ${contractUuid}, caused by item ${JSON.stringify(contractItem)}`, error)
                                continue
                            }
                        }
                        else {
                            console.warn(`no init method on contract ${contractDescription.description} ${contractUuid} for iteration ${iterationId}, ignore`)
                        }
                    } break

                    case 'call': {
                        const { callId, contractUuid, iterationId, method, args } = contractItem['data']

                        if (method == 'init') {
                            console.error(`cannot call the init method (caused by ${JSON.stringify(contractItem)})`)
                            continue
                        }

                        let contractState: ContractState = state.contracts.get(contractUuid)
                        if (!contractState) {
                            console.error(`cannot call a contract without state, ignoring. ${JSON.stringify(contractItem)}`)
                            continue
                        }

                        // check that iterationId is the last one on the contract.
                        // or ignore it if iterationId is undefined
                        if (iterationId !== undefined && iterationId != contractState.currentContractIterationId) {
                            console.warn(`cannot execute call targetting iteration ${iterationId}, current iteration is ${contractState.currentContractIterationId}`)
                            continue
                        }

                        let liveInstance = this.getLiveInstance(contractUuid, iterationId)
                        if (!(method in liveInstance)) {
                            console.warn(`cannot apply call, because method ${method} does not exist`)
                            continue
                        }

                        try {
                            let callResult = this.callContractInstance(callId, method, args, liveInstance, contractState, state.returnValues, true)
                            if (callResult)
                                console.log(`call on ${contractUuid}@${iterationId}:${method} produced result : ${JSON.stringify(callResult)}`)
                        }
                        catch (error) {
                            console.error(`error when calling ${method} on contract ${contractUuid}, caused by item ${JSON.stringify(contractItem)}`, error)
                            continue
                        }
                    } break

                    default:
                        console.log(`ignored contract item ${JSON.stringify(contractItem)}`)
                }

            }

            if (idx == sequenceItemsByBlock.length - 1) {
                // store the contract state at the end of the block
                this.stateCache = state
                this.stateCacheBlockId = blockId
            }
        }

        /*if (false) {
            for (let [contractUuid, contractState] of state.contracts.entries()) {
                console.log(``)
                console.log(`Smart contract ${contractUuid}, current iteration : ${contractState.currentContractIterationId}`)
                console.log(`pubKey : ${contractState.contractPublicKey.substr(0, 20)}`)
                console.log(`instance resolved state: ${JSON.stringify(contractState.instanceData, null, 2)}`)
            }
        }*/
    }

    /**
     * 
     * @param callId can be null and won't be registered in resultValues then
     * @param method 
     * @param args 
     * @param liveInstance 
     * @param contractState 
     * @param resultValues a Map where to store result value of the call (if both the map and callId are given)
     * @param commitCall 
     */
    private callContractInstance(callId: string, method: string, args: any, liveInstance: any, contractState: ContractState, resultValues: Map<string, any>, commitCall: boolean) {
        if (!liveInstance)
            throw `liveInstance is null, cannot call contract method`

        if (!(method in liveInstance))
            throw `method ${method} does not exist on contract, cannot apply`

        if (commitCall) {
            //console.log(`applying call to method ${method} of smart contract with params ${JSON.stringify(args)}`)
            console.log(`applying call to method ${method} of smart contract ${contractState.uuid}`)
        }

        // make a copy of the current state
        let backup = JSON.stringify(contractState.instanceData)

        try {
            let callResult = liveInstance[method].apply({
                uuid: contractState.uuid,
                name: contractState.name,
                description: contractState.description,
                currentIterationId: contractState.currentContractIterationId,
                publicKey: contractState.contractPublicKey,
                data: contractState.instanceData
            }, [args])

            //callResult && console.log(`call returned a result : ${JSON.stringify(callResult)}`)

            callId && resultValues && !resultValues.has(callId) && resultValues.set(callId, callResult)

            return callResult
        }
        catch (error) {
            console.warn(`error while executing smart contract code ${contractState.uuid} ${method} ${JSON.stringify(args)}, reverting changes. Error :\n\n`, error)
            console.warn('\r')

            contractState.instanceData = JSON.parse(backup)

            throw error
        }
    }

    private createLiveInstance(contractUuid: string, iterationId: number, code: string, contracts: Map<string, ContractState>, returnValues: Map<string, any>) {
        let liveInstance = null

        let instanceSandbox = {
            JSON,

            console: {
                log: (text, obj) => console.log(`### ${contractUuid}@${iterationId}     LOG: ${text}`, obj),
                warn: (text, obj) => console.warn(`### ${contractUuid}@${iterationId} WARNING: ${text}`, obj),
                error: (text, obj) => console.error(`### ${contractUuid}@${iterationId}   ERROR: ${text}`, obj)
            },

            stateOfContract: (uuid) => {
                if (!liveInstance)
                    throw 'no live instance, are you trying to do something weird?'

                let contractState = contracts.get(uuid)
                if (!contractState) {
                    console.warn(`contract ${contractUuid} asked for state of an unknown contract (${uuid})`)
                    return null
                }

                console.log(`contract ${contractUuid} asked for state of contract (${uuid})`)

                // make a clone, so that contract cannot alter the other instance's data
                return JSON.parse(JSON.stringify(contractState.instanceData))
            },

            callContract: (uuid, iterationId, method, args) => {
                if (!liveInstance)
                    throw 'no live instance, are you trying to do something weird?'

                let contractState = contracts.get(uuid)
                if (!contractState) {
                    console.error(`contract ${contractUuid} asked for calling method ${method} on an unknown contract (${uuid}@${iterationId})`)
                    return false
                }

                return this.callContractInstance(null, method, args, this.getLiveInstance(uuid, iterationId), contractState, returnValues, true)
            },

            parseInt,

            lib: {
                checkArgs: (args, names) => {
                    let undefinedArgs = names.filter(n => !(n in args))
                    if (undefinedArgs.length) {
                        console.warn(`missing argument(s) ${undefinedArgs.join()}`)
                        return false
                    }

                    return true
                },

                checkStringArgs: (args, names) => {
                    let undefinedArgs = names.filter(n => !(n in args))
                    if (undefinedArgs.length) {
                        console.warn(`missing argument(s) ${undefinedArgs.join()}`)
                        return false
                    }

                    let wrongTypeArgs = names.filter(n => typeof args[n] !== 'string')
                    if (wrongTypeArgs.length) {
                        console.warn(`wrong argument type(s) ${wrongTypeArgs.join()}`)
                        return false
                    }

                    return true
                },

                verifyPackedData: HashTools.verifyPackedData,
                extractPackedDataBody: HashTools.extractPackedDataBody,
                extractPackedDataPublicKey: HashTools.extractPackedDataPublicKey,

                hash: HashTools.hashStringSync
            }
        }

        try {
            code = 'with (sandbox) { return (' + code + ') }'
            const codeFunction = new Function('sandbox', code)

            liveInstance = function (sandbox) {
                const sandboxProxy = new Proxy(sandbox, {
                    has: () => true,
                    get: (target, key) => {
                        if (key === Symbol.unscopables)
                            return undefined
                        return target[key]
                    }
                })

                return codeFunction(sandboxProxy)
            }(instanceSandbox)

            return liveInstance
        }
        catch (error) {
            console.error(`cannot create live instance of smart contract, probably because of Javascript error\n${error}`)
            return null
        }
    }

    async publishContract(privateKey: string, uuid: string, name: string, description: string, code: string) {
        let signedContractDescription = HashTools.signAndPackData({
            uuid,
            name,
            description,
            code
        }, privateKey)

        return this.contractItemList.addItems([{
            type: 'contract',
            data: signedContractDescription
        }])
    }

    // returns the callId
    // note that this callId could be generated by the caller
    // just that it is more practical to do like this
    async callContract(contractUuid: string, iterationId: number, method: string, args: object = null) {
        const callId = await HashTools.hashString('' + Math.random())

        // TODO have a way to add items in the same block (en effet en l'etat actuel, un seul item par bloc va passer, car un item référence l'item précédent...)
        this.contractItemList.addItems([{
            type: 'call',
            data: {
                callId,
                contractUuid,
                iterationId,
                method,
                args
            }
        }])

        return callId
    }

    async simulateCallContract(contractUuid: string, iterationId: number, method: string, args: object = null) {
        let liveInstance = this.getLiveInstance(contractUuid, iterationId)
        if (!liveInstance)
            return undefined

        return this.callContractInstance(null, method, args, liveInstance, this.stateCache.contracts.get(contractUuid), null, false)
    }

    hasReturnValue(callId: string) {
        return this.stateCache && this.stateCache.returnValues.has(callId)
    }

    getReturnValue(callId: string) {
        return this.stateCache && this.stateCache.returnValues.get(callId)
    }
}